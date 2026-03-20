const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ─── Security headers ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// Serve static files from public/
app.use(express.static(path.join(__dirname, '../public')));

// ─── IP helpers ───────────────────────────────────────────────────────────────
function getIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  return (forwarded ? forwarded.split(',')[0] : req.socket.remoteAddress || 'unknown').trim();
}

function maskIP(ip) {
  const parts = ip.split('.');
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.x.x`;
  }
  // IPv6 — keep first two groups only
  const groups = ip.split(':');
  return `${groups[0]}:${groups[1] || 'x'}:x:x:x:x:x:x`;
}

function ts() {
  return new Date().toISOString();
}

// ─── IP rate limiting ─────────────────────────────────────────────────────────
// ip -> Set of active WebSocket objects
const ipConnections = new Map();
const MAX_CONNECTIONS_PER_IP = 2;

// ip -> timestamp of most recent 'join' message (dual-connection detection)
const ipJoinTimes = new Map();
const DUAL_JOIN_WINDOW_MS = 10_000;

// ─── Matchmaking state ────────────────────────────────────────────────────────
let waitingUser = null;
const peers = new Map();
let nextId = 1;

function genId() {
  return `user-${nextId++}`;
}

function send(ws, data) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ─── WebSocket connections ────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const ip = getIP(req);
  const masked = maskIP(ip);

  // Enforce per-IP connection limit
  if (!ipConnections.has(ip)) ipConnections.set(ip, new Set());
  const connSet = ipConnections.get(ip);

  if (connSet.size >= MAX_CONNECTIONS_PER_IP) {
    console.log(`[BLOCKED] ${ts()} Too many connections from ${masked}`);
    send(ws, { type: 'error', message: 'Too many connections from your IP' });
    ws.close();
    return;
  }

  connSet.add(ws);

  const id = genId();
  ws.userId = id;
  ws.partnerId = null;
  ws.clientIp = ip;

  console.log(`[+] ${ts()} ${id} connected from ${masked}`);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const { type, payload } = msg;

    switch (type) {
      case 'join': {
        // Dual-connection detection: two joins from same IP within 10 s
        const now = Date.now();
        const lastJoin = ipJoinTimes.get(ip);
        if (lastJoin !== undefined && now - lastJoin < DUAL_JOIN_WINDOW_MS) {
          console.warn(`[SUSPICIOUS] ${ts()} Dual join from ${masked} — disconnecting both`);
          // Kick any other socket from this IP that is currently waiting
          if (waitingUser && waitingUser.clientIp === ip && waitingUser !== ws) {
            send(waitingUser, { type: 'error', message: 'Suspicious activity detected' });
            waitingUser.close();
            waitingUser = null;
          }
          send(ws, { type: 'error', message: 'Suspicious activity detected' });
          ws.close();
          ipJoinTimes.delete(ip);
          return;
        }
        ipJoinTimes.set(ip, now);

        if (waitingUser && waitingUser.readyState === waitingUser.OPEN && waitingUser !== ws) {
          // Pair them
          const other = waitingUser;
          waitingUser = null;

          ws.partnerId = other.userId;
          other.partnerId = ws.userId;

          peers.set(ws.userId, ws);
          peers.set(other.userId, other);

          console.log(`[~] ${ts()} Paired ${ws.userId} (${masked}) <-> ${other.userId} (${maskIP(other.clientIp)})`);

          // Waiting user becomes caller, newcomer becomes callee
          send(other, { type: 'paired', role: 'caller' });
          send(ws, { type: 'paired', role: 'callee' });
        } else {
          waitingUser = ws;
          peers.set(ws.userId, ws);
          console.log(`[?] ${ts()} ${id} (${masked}) waiting for partner`);
          send(ws, { type: 'waiting' });
        }
        break;
      }

      case 'offer':
      case 'answer':
      case 'ice-candidate': {
        if (ws.partnerId) {
          const partner = peers.get(ws.partnerId);
          if (partner) send(partner, { type, payload });
        }
        break;
      }

      case 'disconnect': {
        handleDisconnect(ws);
        break;
      }
    }
  });

  ws.on('close', () => {
    const set = ipConnections.get(ip);
    if (set) {
      set.delete(ws);
      if (set.size === 0) ipConnections.delete(ip);
    }
    console.log(`[-] ${ts()} ${ws.userId} disconnected (${masked})`);
    handleDisconnect(ws);
  });

  ws.on('error', (err) => {
    console.error(`[!] ${ts()} Error for ${ws.userId} (${masked}):`, err.message);
  });
});

function handleDisconnect(ws) {
  if (waitingUser === ws) waitingUser = null;

  if (ws.partnerId) {
    const partner = peers.get(ws.partnerId);
    if (partner) {
      send(partner, { type: 'partner-disconnected' });
      partner.partnerId = null;
    }
    ws.partnerId = null;
  }

  peers.delete(ws.userId);
}

// ─── Graceful error handling ──────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error(`[UNCAUGHT EXCEPTION] ${ts()}`, err);
});

process.on('unhandledRejection', (reason) => {
  console.error(`[UNHANDLED REJECTION] ${ts()}`, reason);
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Nestham server running on http://localhost:${PORT}`);
});

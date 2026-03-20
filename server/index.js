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
const waitingPool = []; // array of ws objects waiting for match
const peers = new Map();
let nextId = 1;

// ─── Reconnect tokens ─────────────────────────────────────────────────────────
// token -> { user1id, user2id, expires }
const reconnectTokens = new Map();
const RECONNECT_TTL_MS = 60_000;

function genReconnectToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let t = '';
  for (let i = 0; i < 6; i++) t += chars[Math.floor(Math.random() * chars.length)];
  return t;
}

// Clean up expired tokens every 30s
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of reconnectTokens) {
    if (data.expires <= now) reconnectTokens.delete(token);
  }
}, 30_000);

// ─── Matching helpers ─────────────────────────────────────────────────────────
function commonInterests(a, b) {
  if (!a || !b || !a.length || !b.length) return 0;
  return a.filter(i => b.includes(i)).length;
}

function matchScore(a, b) {
  const aRegion = (a.region && a.region !== 'any') ? a.region : null;
  const bRegion = (b.region && b.region !== 'any') ? b.region : null;
  const sameRegion = aRegion && bRegion && aRegion === bRegion;
  const sharedInterest = commonInterests(a.interests, b.interests) > 0;
  if (sameRegion && sharedInterest) return 3;
  if (sameRegion) return 2;
  if (sharedInterest) return 1;
  return 0;
}

// Find best match from waitingPool for ws (ws not yet in pool).
// For the first 30s both parties are strict (require score >= 1).
// After 30s waiting (either party), relax to any (score >= 0).
function findBestMatch(ws) {
  if (!waitingPool.length) return null;
  const now = Date.now();
  const wsRelaxed = ws.joinedPoolAt !== undefined && (now - ws.joinedPoolAt) > 30_000;

  let best = null;
  let bestScore = -1;

  for (const candidate of waitingPool) {
    if (candidate === ws) continue;
    if (candidate.readyState !== candidate.OPEN) continue;

    const score = matchScore(candidate, ws);
    const candidateRelaxed =
      candidate.joinedPoolAt !== undefined && (now - candidate.joinedPoolAt) > 30_000;
    const minScore = (wsRelaxed || candidateRelaxed) ? 0 : 1;

    if (score >= minScore && score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

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
  ws.region = null;
  ws.interests = [];
  ws.reconnectToken = null;

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
          const suspIdx = waitingPool.findIndex(u => u.clientIp === ip && u !== ws);
          if (suspIdx !== -1) {
            const susp = waitingPool.splice(suspIdx, 1)[0];
            send(susp, { type: 'error', message: 'Suspicious activity detected' });
            susp.close();
          }
          send(ws, { type: 'error', message: 'Suspicious activity detected' });
          ws.close();
          ipJoinTimes.delete(ip);
          return;
        }
        ipJoinTimes.set(ip, now);

        // Store preferences from payload
        if (payload && typeof payload === 'object') {
          ws.region = typeof payload.region === 'string' ? payload.region : null;
          ws.interests = Array.isArray(payload.interests) ? payload.interests.slice(0, 3) : [];
          ws.reconnectToken = typeof payload.reconnectToken === 'string' ? payload.reconnectToken : null;
        }

        // Reconnect token check — pair immediately if the other user is in the pool
        if (ws.reconnectToken) {
          const tokenData = reconnectTokens.get(ws.reconnectToken);
          if (tokenData && tokenData.expires > now) {
            const otherIdx = waitingPool.findIndex(
              u => u.reconnectToken === ws.reconnectToken && u !== ws && u.readyState === u.OPEN
            );
            if (otherIdx !== -1) {
              const other = waitingPool.splice(otherIdx, 1)[0];
              reconnectTokens.delete(ws.reconnectToken);

              ws.partnerId = other.userId;
              other.partnerId = ws.userId;
              peers.set(ws.userId, ws);
              peers.set(other.userId, other);

              console.log(`[~R] ${ts()} Reconnected ${ws.userId} (${masked}) <-> ${other.userId} (${maskIP(other.clientIp)})`);
              send(other, { type: 'paired', payload: { role: 'caller' } });
              send(ws, { type: 'paired', payload: { role: 'callee' } });
              return;
            }
            // Other user not yet in pool — fall through to normal matching / join pool
          }
        }

        // Normal preference-based matching
        const match = findBestMatch(ws);
        if (match) {
          const idx = waitingPool.indexOf(match);
          if (idx !== -1) waitingPool.splice(idx, 1);

          ws.partnerId = match.userId;
          match.partnerId = ws.userId;
          peers.set(ws.userId, ws);
          peers.set(match.userId, match);

          console.log(`[~] ${ts()} Paired ${ws.userId} (${masked}) <-> ${match.userId} (${maskIP(match.clientIp)})`);
          send(match, { type: 'paired', payload: { role: 'caller' } });
          send(ws, { type: 'paired', payload: { role: 'callee' } });
        } else {
          ws.joinedPoolAt = now;
          waitingPool.push(ws);
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
  // Remove from waiting pool
  const poolIdx = waitingPool.indexOf(ws);
  if (poolIdx !== -1) waitingPool.splice(poolIdx, 1);

  if (ws.partnerId) {
    const partner = peers.get(ws.partnerId);

    // Generate a 6-char reconnect token valid for 60s, send to both parties
    const token = genReconnectToken();
    const expires = Date.now() + RECONNECT_TTL_MS;
    reconnectTokens.set(token, { user1id: ws.userId, user2id: ws.partnerId, expires });

    send(ws, { type: 'reconnect-token', payload: token });

    if (partner) {
      send(partner, { type: 'partner-disconnected' });
      send(partner, { type: 'reconnect-token', payload: token });
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

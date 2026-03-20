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
const waitingPool = []; // replaces single waitingUser
const peers = new Map();
let nextId = 1;

// ─── Reconnect tokens ─────────────────────────────────────────────────────────
// token -> { expires: timestamp }  (userIds no longer needed — matched by token on ws)
const reconnectTokens = new Map();
const RECONNECT_TTL_MS = 60_000;
const RELAXED_WAIT_MS = 30_000;

function genToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// Clean up expired reconnect tokens every 30 seconds
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of reconnectTokens) {
    if (data.expires < now) reconnectTokens.delete(token);
  }
  // Also prune closed sockets from waitingPool
  for (let i = waitingPool.length - 1; i >= 0; i--) {
    if (waitingPool[i].readyState !== waitingPool[i].OPEN) {
      waitingPool.splice(i, 1);
    }
  }
}, 30_000);

function genId() {
  return `user-${nextId++}`;
}

function send(ws, data) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ─── Matchmaking helpers ──────────────────────────────────────────────────────

/**
 * Find the best available match in waitingPool for `ws`.
 * Priority: region+interest > region-only > interest-only > relaxed (30s wait) > any
 * Returns the index in waitingPool, or -1 if no match.
 */
function findBestMatch(ws) {
  const now = Date.now();
  let regionInterest = -1;
  let regionOnly = -1;
  let interestOnly = -1;
  let relaxedUser = -1;
  let anyUser = -1;

  for (let i = 0; i < waitingPool.length; i++) {
    const c = waitingPool[i];
    if (c === ws || c.readyState !== c.OPEN) continue;

    // Candidate has been waiting > 30s — they match anyone
    const cRelaxed = (now - c.joinTime) > RELAXED_WAIT_MS;
    if (cRelaxed) {
      if (relaxedUser === -1) relaxedUser = i;
      continue;
    }

    const sameRegion =
      ws.region === 'any' || c.region === 'any' || ws.region === c.region;
    const sharedInterest =
      ws.interests.length === 0 ||
      c.interests.length === 0 ||
      ws.interests.some(int => c.interests.includes(int));

    if (sameRegion && sharedInterest && regionInterest === -1) {
      regionInterest = i;
    } else if (sameRegion && !sharedInterest && regionOnly === -1) {
      regionOnly = i;
    } else if (!sameRegion && sharedInterest && interestOnly === -1) {
      interestOnly = i;
    } else if (anyUser === -1) {
      anyUser = i;
    }
  }

  if (regionInterest !== -1) return regionInterest;
  if (regionOnly !== -1) return regionOnly;
  if (interestOnly !== -1) return interestOnly;
  if (relaxedUser !== -1) return relaxedUser;
  return anyUser;
}

/** Remove ws from waitingPool (safe no-op if not present). */
function removeFromPool(ws) {
  const idx = waitingPool.indexOf(ws);
  if (idx !== -1) waitingPool.splice(idx, 1);
}

/** Pair a new joiner with an existing pool user. Pool user becomes caller. */
function pairUsers(newUser, poolUser) {
  removeFromPool(poolUser);
  removeFromPool(newUser); // in case newUser was already in pool (reconnect edge case)

  newUser.partnerId = poolUser.userId;
  poolUser.partnerId = newUser.userId;

  peers.set(newUser.userId, newUser);
  peers.set(poolUser.userId, poolUser);

  console.log(
    `[~] ${ts()} Paired ${newUser.userId} (${maskIP(newUser.clientIp)}) <-> ` +
    `${poolUser.userId} (${maskIP(poolUser.clientIp)})`
  );

  // Waiting user (pool) = caller; new joiner = callee
  send(poolUser, { type: 'paired', payload: { role: 'caller' } });
  send(newUser,  { type: 'paired', payload: { role: 'callee' } });
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
  ws.region = 'any';
  ws.interests = [];
  ws.joinTime = null;
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
        const now = Date.now();

        // Parse v2 preferences from payload
        const region       = payload?.region || 'any';
        const interests    = Array.isArray(payload?.interests) ? payload.interests.slice(0, 3) : [];
        const reconnectTok = payload?.reconnectToken || null;

        ws.region         = region;
        ws.interests      = interests;
        ws.joinTime       = now;
        ws.reconnectToken = reconnectTok;

        // ── Dual-connection detection: two joins from same IP within 10 s ──
        const lastJoin = ipJoinTimes.get(ip);
        if (lastJoin !== undefined && now - lastJoin < DUAL_JOIN_WINDOW_MS) {
          console.warn(`[SUSPICIOUS] ${ts()} Dual join from ${masked} — disconnecting both`);
          // Kick any same-IP sockets currently in the pool
          for (let i = waitingPool.length - 1; i >= 0; i--) {
            if (waitingPool[i].clientIp === ip && waitingPool[i] !== ws) {
              send(waitingPool[i], { type: 'error', message: 'Suspicious activity detected' });
              waitingPool[i].close();
              waitingPool.splice(i, 1);
            }
          }
          send(ws, { type: 'error', message: 'Suspicious activity detected' });
          ws.close();
          ipJoinTimes.delete(ip);
          return;
        }
        ipJoinTimes.set(ip, now);

        // ── 1. Reconnect token: match with the other half of a previous pair ──
        if (reconnectTok && reconnectTokens.has(reconnectTok)) {
          const tokenData = reconnectTokens.get(reconnectTok);
          if (tokenData.expires > now) {
            const otherIdx = waitingPool.findIndex(
              u => u.reconnectToken === reconnectTok && u !== ws && u.readyState === u.OPEN
            );
            if (otherIdx !== -1) {
              const other = waitingPool[otherIdx];
              reconnectTokens.delete(reconnectTok);
              console.log(`[↩] ${ts()} Reconnect pair: ${ws.userId} <-> ${other.userId}`);
              pairUsers(ws, other);
              return;
            }
            // Other half not in pool yet — enter pool with this token and wait
          } else {
            reconnectTokens.delete(reconnectTok);
            ws.reconnectToken = null;
          }
        }

        // ── 2–5. Find best match among waiting users ──
        const matchIdx = findBestMatch(ws);
        if (matchIdx !== -1) {
          pairUsers(ws, waitingPool[matchIdx]);
        } else {
          // ── 6. No match — join the waiting pool ──
          waitingPool.push(ws);
          peers.set(ws.userId, ws);
          console.log(`[?] ${ts()} ${id} (${masked}) waiting (pool: ${waitingPool.length})`);
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
  removeFromPool(ws);

  if (ws.partnerId) {
    const partner = peers.get(ws.partnerId);
    if (partner) {
      // Generate a reconnect token so both sides can find each other again
      const token = genToken();
      reconnectTokens.set(token, { expires: Date.now() + RECONNECT_TTL_MS });

      send(partner, { type: 'partner-disconnected' });
      send(partner, { type: 'reconnect-token', token });
      send(ws,      { type: 'reconnect-token', token }); // only reaches ws if still OPEN
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

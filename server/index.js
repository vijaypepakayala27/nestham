require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const pool = require('./db');
const runMigrations = require('./migrations');
const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const JWT_SECRET = process.env.JWT_SECRET || 'nestham_secret_2026';

// Run DB migrations on startup
runMigrations();

// ─── Security headers ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// Serve static files from public/
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

// ─── Session middleware ────────────────────────────────────────────────────────
app.use((req, res, next) => {
  req.userId = null;
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/nestham_session=([^;]+)/);
  if (match) {
    try {
      const decoded = jwt.verify(match[1], JWT_SECRET);
      req.userId = decoded.userId;
    } catch {}
  }
  next();
});

// ─── Auth helpers ─────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

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


// ─── TURN credentials endpoint ────────────────────────────────────────────────
// Generate time-limited TURN credentials using HMAC (RFC 5389)
const crypto = require('crypto');
app.get('/api/turn-credentials', (req, res) => {
  const secret = process.env.TURN_SECRET || 'nestham_turn_secret_2026';
  const ttl = 3600; // 1 hour
  const username = Math.floor(Date.now() / 1000) + ttl + ':nestham';
  const hmac = crypto.createHmac('sha1', secret);
  hmac.update(username);
  const credential = hmac.digest('base64');
  res.json({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
    username,
    credential
  });
});
// ─── Matchmaking state ────────────────────────────────────────────────────────
const waitingPool = []; // array of ws objects waiting for match
const peers = new Map();
let nextId = 1;

// ─── Online count ─────────────────────────────────────────────────────────────
let onlineCount = 0;

function broadcastOnlineCount() {
  const msg = JSON.stringify({ type: 'online-count', count: onlineCount });
  wss.clients.forEach(client => {
    if (client.readyState === client.OPEN) {
      client.send(msg);
    }
  });
}

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
    const minScore = 0; // always match anyone, score just determines best match

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

// ─── DB: log session start ────────────────────────────────────────────────────
async function logSessionStart(ws, partner) {
  if (!ws.dbUserId || !partner.dbUserId) return;
  try {
    const res = await pool.query(
      `INSERT INTO sessions (user1_id, user2_id, region, interests)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [ws.dbUserId, partner.dbUserId, ws.region || null, ws.interests || []]
    );
    const sessionId = res.rows[0].id;
    ws.sessionDbId = sessionId;
    partner.sessionDbId = sessionId;
    ws.sessionStartedAt = Date.now();
    partner.sessionStartedAt = Date.now();
    // Notify both clients of session ID and partner DB user ID
    send(ws, { type: 'session-logged', sessionId, partnerId: partner.dbUserId });
    send(partner, { type: 'session-logged', sessionId, partnerId: ws.dbUserId });
  } catch (err) {
    console.error('[DB] logSessionStart error:', err.message);
  }
}

// ─── DB: log session end ──────────────────────────────────────────────────────
async function logSessionEnd(sessionDbId, startedAt) {
  if (!sessionDbId) return;
  try {
    const duration = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : null;
    await pool.query(
      `UPDATE sessions SET ended_at = now(), duration_seconds = $1 WHERE id = $2`,
      [duration, sessionDbId]
    );
  } catch (err) {
    console.error('[DB] logSessionEnd error:', err.message);
  }
}

// ─── Google OAuth ─────────────────────────────────────────────────────────────
app.get('/auth/google', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.BASE_URL + '/auth/google/callback',
    response_type: 'code',
    scope: 'profile email',
    access_type: 'online',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.BASE_URL + '/auth/google/callback',
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.redirect('/?error=token_failed');

    // Get user profile
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await profileRes.json();
    if (!profile.id) return res.redirect('/?error=profile_failed');

    // Upsert user in DB
    const result = await pool.query(
      `INSERT INTO users (google_id, display_name, email, avatar)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (google_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         email = EXCLUDED.email,
         avatar = EXCLUDED.avatar
       RETURNING id`,
      [profile.id, profile.name || 'User', profile.email || null, profile.picture || null]
    );
    const userId = result.rows[0].id;

    // Upsert online_status row
    await pool.query(
      `INSERT INTO online_status (user_id, is_online) VALUES ($1, false)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );

    // Set session cookie
    const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });
    res.setHeader('Set-Cookie', `nestham_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
    res.redirect('/?loggedin=1');
  } catch (err) {
    console.error('[AUTH] Google callback error:', err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'nestham_session=; Path=/; HttpOnly; Max-Age=0');
  res.redirect('/');
});

// ─── REST endpoints ───────────────────────────────────────────────────────────
app.get('/api/online', (req, res) => {
  res.json({ count: onlineCount });
});

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, display_name, email, avatar FROM users WHERE id = $1', [req.userId]);
    if (!result.rows.length) return res.status(401).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[DB] /api/me error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/history', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.region, s.interests, s.started_at, s.ended_at, s.duration_seconds,
              CASE WHEN s.user1_id = $1 THEN u2.display_name ELSE u1.display_name END AS partner_name,
              CASE WHEN s.user1_id = $1 THEN u2.avatar ELSE u1.avatar END AS partner_avatar,
              CASE WHEN s.user1_id = $1 THEN u2.id ELSE u1.id END AS partner_id
       FROM sessions s
       JOIN users u1 ON s.user1_id = u1.id
       JOIN users u2 ON s.user2_id = u2.id
       WHERE s.user1_id = $1 OR s.user2_id = $1
       ORDER BY s.started_at DESC
       LIMIT 20`,
      [req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[DB] /api/history error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/session/:id/messages', requireAuth, async (req, res) => {
  try {
    // Verify user was a participant
    const sessionCheck = await pool.query(
      'SELECT id FROM sessions WHERE id = $1 AND (user1_id = $2 OR user2_id = $2)',
      [req.params.id, req.userId]
    );
    if (!sessionCheck.rows.length) return res.status(403).json({ error: 'Forbidden' });

    const result = await pool.query(
      `SELECT m.id, m.content, m.sent_at, u.display_name AS sender_name, u.avatar AS sender_avatar
       FROM messages m
       JOIN users u ON m.sender_id = u.id
       WHERE m.session_id = $1
       ORDER BY m.sent_at ASC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[DB] /api/session/:id/messages error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Friends endpoints ────────────────────────────────────────────────────────
app.post('/api/friends/request', requireAuth, async (req, res) => {
  const { friendId } = req.body || {};
  if (!friendId) return res.status(400).json({ error: 'friendId required' });
  if (friendId === req.userId) return res.status(400).json({ error: 'Cannot add yourself' });
  try {
    await pool.query(
      `INSERT INTO friends (user1_id, user2_id, status) VALUES ($1, $2, 'pending')
       ON CONFLICT (user1_id, user2_id) DO NOTHING`,
      [req.userId, friendId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[DB] /api/friends/request error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/friends/accept', requireAuth, async (req, res) => {
  const { friendId } = req.body || {};
  if (!friendId) return res.status(400).json({ error: 'friendId required' });
  try {
    await pool.query(
      `UPDATE friends SET status = 'accepted'
       WHERE user1_id = $1 AND user2_id = $2 AND status = 'pending'`,
      [friendId, req.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[DB] /api/friends/accept error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/friends', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.display_name, u.avatar,
              os.is_online, os.last_seen
       FROM friends f
       JOIN users u ON (
         CASE WHEN f.user1_id = $1 THEN f.user2_id ELSE f.user1_id END = u.id
       )
       LEFT JOIN online_status os ON os.user_id = u.id
       WHERE (f.user1_id = $1 OR f.user2_id = $1) AND f.status = 'accepted'`,
      [req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[DB] /api/friends error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/friends/requests', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.display_name, u.avatar, f.created_at
       FROM friends f
       JOIN users u ON f.user1_id = u.id
       WHERE f.user2_id = $1 AND f.status = 'pending'
       ORDER BY f.created_at DESC`,
      [req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[DB] /api/friends/requests error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Online status ────────────────────────────────────────────────────────────
app.get('/api/online-status/:userId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT is_online, last_seen FROM online_status WHERE user_id = $1',
      [req.params.userId]
    );
    if (!result.rows.length) return res.json({ isOnline: false, lastSeen: null });
    const { is_online, last_seen } = result.rows[0];
    res.json({ isOnline: is_online, lastSeen: last_seen });
  } catch (err) {
    console.error('[DB] /api/online-status error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Report endpoint ──────────────────────────────────────────────────────────
app.post('/api/report', async (req, res) => {
  const { reason, reportedIp, sessionId } = req.body || {};
  const ip = getIP(req);
  const masked = reportedIp ? maskIP(String(reportedIp)) : 'unknown';
  console.log(`[REPORT] ${ts()} reason="${reason || 'none'}" ip=${masked}`);
  // Fire-and-forget DB insert
  pool.query(
    'INSERT INTO reports (reporter_ip, session_id, reason) VALUES ($1, $2, $3)',
    [ip, sessionId || null, reason || null]
  ).catch(err => console.error('[DB] report insert error:', err.message));
  res.json({ ok: true });
});

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
  onlineCount++;
  broadcastOnlineCount();

  const id = genId();
  ws.userId = id;
  ws.partnerId = null;
  ws.clientIp = ip;
  ws.region = null;
  ws.interests = [];
  ws.reconnectToken = null;
  ws.dbUserId = null;       // DB UUID set on auth message
  ws.sessionDbId = null;    // DB session UUID set when paired
  ws.sessionStartedAt = null;

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
      case 'auth': {
        // Client sends { type: 'auth', userId } with their DB UUID after connect
        const dbUserId = payload && typeof payload === 'string' ? payload : null;
        if (dbUserId) {
          ws.dbUserId = dbUserId;
          // Update online status
          pool.query(
            `INSERT INTO online_status (user_id, is_online, last_seen) VALUES ($1, true, now())
             ON CONFLICT (user_id) DO UPDATE SET is_online = true, last_seen = now()`,
            [dbUserId]
          ).catch(err => console.error('[DB] online_status update error:', err.message));
        }
        break;
      }

      case 'join': {
        // Dual-connection detection: only block if same IP joins within 100ms (bot behaviour)
        // Skip check for localhost (testing/development)
        const now = Date.now();
        const lastJoin = ipJoinTimes.get(ip);
        const isLocalhost = ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1';
        if (!isLocalhost && lastJoin !== undefined && now - lastJoin < 100) {
          console.warn(`[SUSPICIOUS] ${ts()} Rapid dual join from ${masked} — disconnecting both`);
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
              // Log reconnected session
              logSessionStart(ws, other);
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
          // Log session to DB
          logSessionStart(ws, match);
        } else {
          ws.joinedPoolAt = now;
          waitingPool.push(ws);
          peers.set(ws.userId, ws);
          console.log(`[?] ${ts()} ${id} (${masked}) waiting for partner`);
          send(ws, { type: 'waiting', poolSize: waitingPool.length - 1 });
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

      case 'chat': {
        if (ws.partnerId) {
          const partner = peers.get(ws.partnerId);
          if (partner) send(partner, { type, payload });
          // Log message to DB if both authenticated and session is logged
          if (ws.sessionDbId && ws.dbUserId && payload && typeof payload.text === 'string') {
            pool.query(
              'INSERT INTO messages (session_id, sender_id, content) VALUES ($1, $2, $3)',
              [ws.sessionDbId, ws.dbUserId, payload.text]
            ).catch(err => console.error('[DB] message insert error:', err.message));
          }
        }
        break;
      }

      case 'typing': {
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
    onlineCount = Math.max(0, onlineCount - 1);
    broadcastOnlineCount();
    console.log(`[-] ${ts()} ${ws.userId} disconnected (${masked})`);

    // Update online status
    if (ws.dbUserId) {
      pool.query(
        'UPDATE online_status SET is_online = false, last_seen = now() WHERE user_id = $1',
        [ws.dbUserId]
      ).catch(err => console.error('[DB] online_status disconnect error:', err.message));
    }

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

  // End session in DB
  if (ws.sessionDbId) {
    logSessionEnd(ws.sessionDbId, ws.sessionStartedAt);
    ws.sessionDbId = null;
    ws.sessionStartedAt = null;
  }

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
      // End partner's session tracking too
      if (partner.sessionDbId) {
        logSessionEnd(partner.sessionDbId, partner.sessionStartedAt);
        partner.sessionDbId = null;
        partner.sessionStartedAt = null;
      }
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

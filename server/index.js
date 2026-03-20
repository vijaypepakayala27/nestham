const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve static files from public/
app.use(express.static(path.join(__dirname, '../public')));

// Matchmaking queue
let waitingUser = null;

// Track active pairs: peerId -> peerSocket
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

wss.on('connection', (ws) => {
  const id = genId();
  ws.userId = id;
  ws.partnerId = null;

  console.log(`[+] ${id} connected`);

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
        if (waitingUser && waitingUser.readyState === waitingUser.OPEN && waitingUser !== ws) {
          // Pair them
          const other = waitingUser;
          waitingUser = null;

          ws.partnerId = other.userId;
          other.partnerId = ws.userId;

          peers.set(ws.userId, ws);
          peers.set(other.userId, other);

          console.log(`[~] Paired ${ws.userId} <-> ${other.userId}`);

          // Tell the waiting user to create the offer
          send(other, { type: 'paired', role: 'caller' });
          send(ws, { type: 'paired', role: 'callee' });
        } else {
          // Put in queue
          waitingUser = ws;
          peers.set(ws.userId, ws);
          console.log(`[?] ${id} waiting for partner`);
          send(ws, { type: 'waiting' });
        }
        break;
      }

      case 'offer':
      case 'answer':
      case 'ice-candidate': {
        if (ws.partnerId) {
          const partner = peers.get(ws.partnerId);
          if (partner) {
            send(partner, { type, payload });
          }
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
    console.log(`[-] ${ws.userId} disconnected`);
    handleDisconnect(ws);
  });

  ws.on('error', (err) => {
    console.error(`[!] Error for ${ws.userId}:`, err.message);
  });
});

function handleDisconnect(ws) {
  // Remove from waiting queue if present
  if (waitingUser === ws) {
    waitingUser = null;
  }

  // Notify partner
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

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Nestham server running on http://localhost:${PORT}`);
});

# Nestham

A random voice chat app — talk to a stranger, voice only. Like Omegle but audio-only, anonymous, and simple.

## Tech

- **Server**: Node.js + Express + WebSocket (`ws`) — signaling only, no media relay
- **Frontend**: Single `index.html`, zero build step, vanilla JS/CSS
- **WebRTC**: Direct peer-to-peer audio via Google STUN

## Run Locally

```bash
# Install dependencies
cd server
npm install

# Start the server (serves both WS + static files on port 3001)
npm start
```

Open `http://localhost:3001` in two browser tabs (or two devices on the same network).

## How It Works

1. Both users connect via WebSocket → server pairs them
2. Server sends `paired` signal with roles (caller / callee)
3. Caller creates WebRTC offer → server relays SDP + ICE candidates
4. Direct P2P audio connection established
5. Server only handles signaling — audio goes peer-to-peer

## Deploy

### Option A: Railway (easiest — single service)

The server already serves the `public/` folder as static files.

1. Push repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Set root directory to `server/` (or add a `railway.toml`)
4. Set `PORT` env var (Railway injects it automatically)
5. Done — one URL for everything

**`railway.toml`** (create at repo root if needed):
```toml
[build]
builder = "nixpacks"

[deploy]
startCommand = "node server/index.js"
```

### Option B: Render

1. New Web Service → connect GitHub repo
2. Build command: `cd server && npm install`
3. Start command: `node server/index.js`
4. Port: `3001` (or use `$PORT`)

### Option C: Split deploy (Vercel + Railway)

- Deploy `server/` to Railway/Render
- Deploy `public/` to Vercel or Cloudflare Pages
- Update `WS_URL` in `index.html` to point to your Railway URL

```js
// In index.html, replace the WS_URL logic with:
const WS_URL = 'wss://your-app.railway.app';
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `3001`  | Server port |

## Notes

- Works on Chrome and Safari mobile
- No accounts, no recordings, no logs
- Audio goes directly peer-to-peer after signaling — server never sees audio
- For production, consider adding a TURN server (Twilio, Metered.ca) for users behind strict NATs

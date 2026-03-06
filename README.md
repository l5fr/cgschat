# ⚡ NEXUS Chat — Pure Node.js

Zero npm dependencies. One command to run. Works everywhere.

## Run locally (2 seconds)

```bash
node server.js
```

Open http://localhost:3000 in multiple browser tabs — messages sync instantly across all of them.

Open the same URL on your phone (same WiFi) — it syncs there too.

---

## How it works

- **WebSocket server** built from scratch using Node.js `http` + manual RFC 6455 frame parsing
- **REST API** for auth (`/api/register`, `/api/login`, `/api/verify`) using `http`
- **Passwords** hashed with PBKDF2 (100k iterations, SHA-512) via Node `crypto`
- **Tokens** signed with HMAC-SHA256 — no JWT library needed
- **Persistence** — users + messages saved to `data/users.json` and `data/messages.json`
- **Frontend** — single HTML file served as static content

Everything in **one file: `server.js`** (~250 lines). No `node_modules`.

---

## Deploy (make it globally accessible)

### Railway (recommended — free tier)

1. Push to GitHub
2. Go to https://railway.app → New Project → Deploy from GitHub
3. Select your repo → it auto-detects `node server.js` from `package.json`
4. Done — you get a public URL like `https://nexus-chat.railway.app`

### Render

1. Push to GitHub  
2. Go to https://render.com → New → Web Service
3. Build command: (leave empty)
4. Start command: `node server.js`
5. Done — free tier works great

### Fly.io

```bash
fly launch
fly deploy
```

### VPS / Linux

```bash
git clone your-repo && cd nexus-chat
node server.js   # or use pm2 for production
```

For SSL (HTTPS/WSS), put nginx in front:
```nginx
location /ws {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
location / {
    proxy_pass http://localhost:3000;
}
```

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `3000`  | HTTP port   |
| `SECRET` | random  | Token signing key — set this in production! |

```bash
PORT=8080 SECRET=your-secret-key node server.js
```

---

## File structure

```
nexus-chat/
├── server.js        ← entire backend (zero deps)
├── package.json
├── public/
│   └── index.html   ← entire frontend
└── data/            ← auto-created
    ├── users.json   ← accounts
    └── messages.json← chat history
```

Note: Vercel does NOT work for this — Vercel is serverless and doesn't support persistent WebSocket connections.  
Use Railway, Render, Fly.io, or any VPS instead.

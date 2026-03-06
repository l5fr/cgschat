/**
 * NEXUS Chat Server
 * Pure Node.js — zero npm dependencies
 * WebSocket from scratch, PBKDF2 passwords, HMAC session tokens
 * File-based persistence (JSON) — drop-in, no DB needed
 */

'use strict';

const http   = require('http');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const url    = require('url');

// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────
const PORT        = process.env.PORT || 3000;
const SECRET      = process.env.SECRET || crypto.randomBytes(32).toString('hex');
const DATA_DIR    = path.join(__dirname, 'data');
const USERS_FILE  = path.join(DATA_DIR, 'users.json');
const MSGS_FILE   = path.join(DATA_DIR, 'messages.json');
const MAX_MSGS    = 200;   // messages kept in memory + file
const MAX_IMG_KB  = 2048;  // 2MB base64 images
const MAX_FILE_KB = 4096;  // 4MB files

// ─────────────────────────────────────────────
//  PERSISTENCE
// ─────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}

function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch(e) { console.error('Save error:', e.message); }
}

// In-memory state (flushed to disk)
const users    = loadJSON(USERS_FILE, {});   // uid -> { uid, name, avatar, email, passHash, passSalt, created }
const messages = loadJSON(MSGS_FILE,  []);   // [{id,uid,name,avatar,type,content,ts,time,...}]

// ─────────────────────────────────────────────
//  AUTH HELPERS  (pure crypto, no deps)
// ─────────────────────────────────────────────
function hashPass(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

function makeToken(uid) {
  const payload = Buffer.from(JSON.stringify({ uid, iat: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(parts[0]).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(parts[1]), Buffer.from(expected))) return null;
  try {
    const { uid, iat } = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (Date.now() - iat > 30 * 24 * 60 * 60 * 1000) return null; // 30-day expiry
    return uid;
  } catch { return null; }
}

function findByEmail(email) {
  return Object.values(users).find(u => u.email === email.toLowerCase().trim());
}

// ─────────────────────────────────────────────
//  WEBSOCKET — PURE IMPLEMENTATION
// ─────────────────────────────────────────────
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsHandshake(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return false; }
  const accept = crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n'
  ].join('\r\n'));
  return true;
}

// Parse one or more WebSocket frames from a buffer
function parseFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const b0 = buf[offset];
    const b1 = buf[offset + 1];
    const fin     = (b0 & 0x80) !== 0;
    const opcode  = b0 & 0x0F;
    const masked  = (b1 & 0x80) !== 0;
    let payloadLen = b1 & 0x7F;
    let headerLen = 2;

    if (payloadLen === 126) {
      if (offset + 4 > buf.length) break;
      payloadLen = buf.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (payloadLen === 127) {
      if (offset + 10 > buf.length) break;
      payloadLen = Number(buf.readBigUInt64BE(offset + 2));
      headerLen = 10;
    }

    if (masked) headerLen += 4;
    if (offset + headerLen + payloadLen > buf.length) break;

    let payload = buf.slice(offset + headerLen, offset + headerLen + payloadLen);
    if (masked) {
      const mask = buf.slice(offset + headerLen - 4, offset + headerLen);
      const unmasked = Buffer.alloc(payloadLen);
      for (let i = 0; i < payloadLen; i++) unmasked[i] = payload[i] ^ mask[i % 4];
      payload = unmasked;
    }

    frames.push({ fin, opcode, payload });
    offset += headerLen + payloadLen;
  }
  return { frames, remaining: buf.slice(offset) };
}

// Encode a text message as a WebSocket frame
function wsFrame(data) {
  const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  const len = payload.length;
  let header;
  if (len <= 125) {
    header = Buffer.from([0x81, len]);
  } else if (len <= 65535) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// Send close frame
function wsSendClose(socket) {
  try { socket.write(Buffer.from([0x88, 0x00])); } catch {}
}

// ─────────────────────────────────────────────
//  CONNECTED CLIENTS
// ─────────────────────────────────────────────
const clients = new Map(); // socket -> { uid, name, avatar }
let presenceMap = {};      // uid -> { name, avatar }

function broadcast(msg, exclude) {
  const frame = wsFrame(msg);
  for (const [sock] of clients) {
    if (sock !== exclude && !sock.destroyed) {
      try { sock.write(frame); } catch {}
    }
  }
}

function sendTo(socket, msg) {
  if (!socket.destroyed) {
    try { socket.write(wsFrame(msg)); } catch {}
  }
}

function updatePresence() {
  presenceMap = {};
  for (const [, info] of clients) {
    if (info.uid) presenceMap[info.uid] = { name: info.name, avatar: info.avatar };
  }
  broadcast({ type: 'presence', users: presenceMap });
}

function nowTs() {
  const d = new Date();
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
}

// ─────────────────────────────────────────────
//  MESSAGE HANDLER (WebSocket)
// ─────────────────────────────────────────────
function handleWsMessage(socket, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  const client = clients.get(socket);

  // ── AUTH: identify ──────────────────────────
  if (msg.type === 'auth') {
    const uid = verifyToken(msg.token);
    if (!uid || !users[uid]) {
      sendTo(socket, { type: 'auth_fail', reason: 'Invalid or expired session' });
      return;
    }
    const u = users[uid];
    client.uid    = uid;
    client.name   = u.name;
    client.avatar = u.avatar;

    // Send last N messages
    sendTo(socket, { type: 'history', messages: messages.slice(-MAX_MSGS) });
    updatePresence();
    return;
  }

  // All following actions require auth
  if (!client?.uid) {
    sendTo(socket, { type: 'error', msg: 'Not authenticated' });
    return;
  }

  const u = users[client.uid];

  // ── CHAT MESSAGE ────────────────────────────
  if (msg.type === 'message') {
    const { subtype, content, fileName, fileSize } = msg;

    // Basic validation
    if (!subtype) return;
    if (subtype === 'text' && (!content || typeof content !== 'string' || content.trim().length === 0)) return;
    if (subtype === 'text' && content.length > 4000) return;

    // Size guard for binary data
    if ((subtype === 'image' || subtype === 'file') && content) {
      const kb = Buffer.byteLength(content, 'utf8') / 1024;
      const limit = subtype === 'image' ? MAX_IMG_KB : MAX_FILE_KB;
      if (kb > limit) {
        sendTo(socket, { type: 'error', msg: `Too large (max ${limit}KB)` });
        return;
      }
    }

    const newMsg = {
      id:      crypto.randomUUID(),
      uid:     client.uid,
      name:    client.name,
      avatar:  client.avatar,
      type:    subtype,
      content: subtype === 'text' ? content.trim() : content,
      ts:      nowTs(),
      time:    Date.now(),
      ...(fileName && { fileName }),
      ...(fileSize && { fileSize })
    };

    messages.push(newMsg);
    if (messages.length > MAX_MSGS + 50) messages.splice(0, messages.length - MAX_MSGS);

    // Persist every 10 messages
    if (messages.length % 10 === 0) saveJSON(MSGS_FILE, messages);

    // Broadcast to ALL including sender so they see it confirmed
    broadcast({ type: 'message', message: newMsg });
    return;
  }

  // ── TYPING ──────────────────────────────────
  if (msg.type === 'typing') {
    broadcast({
      type:  'typing',
      uid:   client.uid,
      name:  client.name,
      state: msg.state // 'start' | 'stop'
    }, socket);
    return;
  }

  // ── PROFILE UPDATE ──────────────────────────
  if (msg.type === 'update_profile') {
    const { name, avatar } = msg;
    if (!name || typeof name !== 'string' || name.trim().length === 0) return;
    const clean = name.trim().slice(0, 24);
    const validAvatars = ['🦊','🐺','🦁','🐉','👾','🤖','👻','🌟','🎭','🔮'];
    const av = validAvatars.includes(avatar) ? avatar : u.avatar;

    users[u.uid].name   = clean;
    users[u.uid].avatar = av;
    client.name   = clean;
    client.avatar = av;
    saveJSON(USERS_FILE, users);
    updatePresence();
    sendTo(socket, { type: 'profile_updated', name: clean, avatar: av });
    return;
  }
}

// ─────────────────────────────────────────────
//  HTTP REST API  (auth + static serving)
// ─────────────────────────────────────────────
function parseBody(req) {
  return new Promise((res, rej) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) { rej(new Error('Too large')); req.destroy(); } });
    req.on('end', () => {
      try { res(JSON.parse(data)); } catch { res({}); }
    });
    req.on('error', rej);
  });
}

function jsonRes(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(payload);
}

async function handleHttp(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }

  // ── REGISTER ────────────────────────────────
  if (pathname === '/api/register' && req.method === 'POST') {
    const body = await parseBody(req).catch(() => ({}));
    const { name, email, password, avatar } = body;

    if (!name || !email || !password)
      return jsonRes(res, 400, { error: 'name, email and password are required' });
    if (password.length < 6)
      return jsonRes(res, 400, { error: 'Password must be at least 6 characters' });
    if (name.trim().length === 0 || name.length > 24)
      return jsonRes(res, 400, { error: 'Name must be 1–24 characters' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return jsonRes(res, 400, { error: 'Invalid email address' });
    if (findByEmail(email))
      return jsonRes(res, 409, { error: 'Email already registered' });

    const uid      = crypto.randomUUID();
    const passSalt = crypto.randomBytes(32).toString('hex');
    const passHash = hashPass(password, passSalt);
    const validAvatars = ['🦊','🐺','🦁','🐉','👾','🤖','👻','🌟','🎭','🔮'];

    users[uid] = {
      uid,
      name:    name.trim().slice(0, 24),
      email:   email.toLowerCase().trim(),
      avatar:  validAvatars.includes(avatar) ? avatar : '🦊',
      passHash,
      passSalt,
      created: Date.now()
    };
    saveJSON(USERS_FILE, users);

    const token = makeToken(uid);
    return jsonRes(res, 201, { token, uid, name: users[uid].name, avatar: users[uid].avatar });
  }

  // ── LOGIN ────────────────────────────────────
  if (pathname === '/api/login' && req.method === 'POST') {
    const body = await parseBody(req).catch(() => ({}));
    const { email, password } = body;

    if (!email || !password)
      return jsonRes(res, 400, { error: 'email and password are required' });

    const u = findByEmail(email);
    if (!u) return jsonRes(res, 401, { error: 'Invalid email or password' });

    const hash = hashPass(password, u.passSalt);
    if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(u.passHash)))
      return jsonRes(res, 401, { error: 'Invalid email or password' });

    const token = makeToken(u.uid);
    return jsonRes(res, 200, { token, uid: u.uid, name: u.name, avatar: u.avatar });
  }

  // ── VERIFY TOKEN ─────────────────────────────
  if (pathname === '/api/verify' && req.method === 'GET') {
    const auth = req.headers['authorization'] || '';
    const token = auth.replace('Bearer ', '');
    const uid = verifyToken(token);
    if (!uid || !users[uid]) return jsonRes(res, 401, { error: 'Invalid token' });
    const u = users[uid];
    return jsonRes(res, 200, { uid, name: u.name, avatar: u.avatar });
  }

  // ── SERVE STATIC FILES ───────────────────────
  if (req.method === 'GET') {
    let filePath = pathname === '/' ? '/index.html' : pathname;
    filePath = path.join(__dirname, 'public', filePath);

    // Security: prevent path traversal
    const publicDir = path.join(__dirname, 'public');
    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }

    const ext = path.extname(filePath);
    const mime = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.ico':'image/x-icon' }[ext] || 'text/plain';

    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': mime });
      fs.createReadStream(filePath).pipe(res);
    } else {
      // SPA fallback
      const index = path.join(__dirname, 'public', 'index.html');
      if (fs.existsSync(index)) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        fs.createReadStream(index).pipe(res);
      } else {
        res.writeHead(404); res.end('Not found');
      }
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
}

// ─────────────────────────────────────────────
//  SERVER BOOTSTRAP
// ─────────────────────────────────────────────
const server = http.createServer(handleHttp);

server.on('upgrade', (req, socket, head) => {
  // Only accept /ws path
  const pathname = url.parse(req.url).pathname;
  if (pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  if (!wsHandshake(req, socket)) return;

  // Register client
  const client = { uid: null, name: null, avatar: null };
  clients.set(socket, client);

  let buf = Buffer.alloc(0);
  let fragments = [];

  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    const { frames, remaining } = parseFrames(buf);
    buf = remaining;

    for (const frame of frames) {
      // Handle continuation frames
      if (frame.opcode === 0x0) fragments.push(frame.payload);
      else if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        if (!frame.fin) { fragments = [frame.payload]; }
        else {
          const full = Buffer.concat([...fragments, frame.payload]);
          fragments = [];
          handleWsMessage(socket, full.toString('utf8'));
        }
      } else if (frame.opcode === 0x8) { // close
        wsSendClose(socket);
        socket.destroy();
      } else if (frame.opcode === 0x9) { // ping → pong
        try { socket.write(Buffer.concat([Buffer.from([0x8A, frame.payload.length]), frame.payload])); } catch {}
      }
    }
  });

  socket.on('close', () => {
    clients.delete(socket);
    updatePresence();
    // Flush messages on client disconnect occasionally
    saveJSON(MSGS_FILE, messages.slice(-MAX_MSGS));
  });

  socket.on('error', () => {
    clients.delete(socket);
    updatePresence();
  });

  // Send initial presence
  sendTo(socket, { type: 'presence', users: presenceMap });
});

server.listen(PORT, () => {
  console.log(`⚡ NEXUS server running on http://localhost:${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`   Data dir:  ${DATA_DIR}`);
});

// Graceful shutdown
process.on('SIGINT',  () => { saveJSON(MSGS_FILE, messages); saveJSON(USERS_FILE, users); process.exit(0); });
process.on('SIGTERM', () => { saveJSON(MSGS_FILE, messages); saveJSON(USERS_FILE, users); process.exit(0); });

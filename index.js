// =====================================================================
// index.js — Express (στατικά αρχεία PWA) + Socket.io (real-time).
// Ένα μόνο service: ιδανικό για Render/Railway.
// =====================================================================
try { require('dotenv').config(); } catch { /* χωρίς dotenv: χρήση env του συστήματος */ }
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const config = require('./config');
const { RoomManager } = require('./rooms');
const llm = require('./llm');

const PORT = process.env.PORT || 3000;
const ORIGIN = process.env.CLIENT_ORIGIN || '*';
const PUBLIC = __dirname; // όλα τα αρχεία στον ίδιο φάκελο (όπως στο GitHub repo)

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // σωστή IP πίσω από τον proxy του Render

// Βασικά security headers (χωρίς επιπλέον εξαρτήσεις)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// Σερβίρουμε ΜΟΝΟ τα αρχεία του frontend — ποτέ τον κώδικα του server
const PUBLIC_FILES = new Set(['style.css', 'app.js', 'manifest.json', 'sw.js', 'icon.svg']);
app.get('/:file', (req, res, next) => {
  if (!PUBLIC_FILES.has(req.params.file)) return next();
  res.sendFile(path.join(PUBLIC, req.params.file), { maxAge: req.params.file === 'sw.js' ? 0 : '1h' });
});

// Δημόσιες ρυθμίσεις για τη φόρμα δημιουργίας δωματίου
app.get('/api/config', (req, res) => {
  res.json({
    categories: config.CATEGORIES.map(({ id, label, default: d }) => ({ id, label, default: d })),
    rounds: config.ROOM.ROUND_OPTIONS,
    times: config.ROOM.TIME_OPTIONS,
    minPlayers: config.ROOM.MIN_PLAYERS,
    maxPlayers: config.ROOM.MAX_PLAYERS,
    avatars: config.AVATARS,
    colors: config.COLORS,
    scoring: config.SCORING,
  });
});

app.get('/health', (req, res) => res.send('ok'));

// Αρχική και /room/AB12 → ίδιο index.html (το frontend διαβάζει το URL)
const sendIndex = (req, res) => res.sendFile(path.join(PUBLIC, 'index.html'));
app.get('/', sendIndex);
app.get('/room/:code', sendIndex);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ORIGIN },
  maxHttpBufferSize: 10_000, // μικρά μηνύματα μόνο
  pingInterval: 20000,
  pingTimeout: 20000,
});
const rooms = new RoomManager(io);

// ---------- Rate limiting ----------
const roomCreations = new Map(); // ip -> [timestamps]
function canCreateRoom(ip) {
  const hourAgo = Date.now() - 3600_000;
  const list = (roomCreations.get(ip) || []).filter((t) => t > hourAgo);
  if (list.length >= config.RATE_LIMIT.ROOMS_PER_IP_PER_HOUR) return false;
  list.push(Date.now());
  roomCreations.set(ip, list);
  return true;
}
setInterval(() => roomCreations.clear(), 3600_000).unref();

io.on('connection', (socket) => {
  const ip = socket.handshake.headers['x-forwarded-for']?.split(',')[0].trim() || socket.handshake.address;

  // Όριο μηνυμάτων ανά σύνδεση (sliding window 10 δευτ.)
  let hits = [];
  socket.use((packet, next) => {
    const t = Date.now();
    hits = hits.filter((h) => t - h < 10_000);
    hits.push(t);
    if (hits.length > config.RATE_LIMIT.SOCKET_EVENTS_PER_10S) return next(new Error('Πολλά αιτήματα, χαλάρωσε λίγο 🙂'));
    next();
  });
  socket.on('error', (err) => socket.emit('toast', { type: 'error', text: err.message }));

  // Ασφαλής περιτύλιξη: πάντα αντικείμενο payload, πάντα ack function
  const on = (event, handler) => {
    socket.on(event, (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const out = handler(payload && typeof payload === 'object' ? payload : {});
        if (out !== undefined) reply(out);
      } catch (err) {
        console.error(`[${event}]`, err);
        reply({ ok: false, error: 'Σφάλμα server' });
      }
    });
  };

  on('time:sync', () => ({ serverNow: Date.now() }));

  on('room:create', (p) => {
    if (!canCreateRoom(ip)) return { ok: false, error: 'Πολλά δωμάτια σε λίγο χρόνο. Δοκίμασε αργότερα.' };
    rooms.leave(socket);
    return rooms.createRoom(socket, p);
  });
  on('room:join', (p) => {
    if (socket.data.roomCode && socket.data.roomCode !== String(p.code || '').toUpperCase()) rooms.leave(socket);
    return rooms.joinRoom(socket, p);
  });
  on('room:leave', () => { rooms.leave(socket); return { ok: true }; });
  on('room:settings', (p) => { rooms.updateSettings(socket, p); });
  on('player:ready', (p) => { rooms.setReady(socket, p.ready); });
  on('game:start', () => rooms.startGame(socket));
  on('answer:submit', (p) => rooms.submitAnswer(socket, p));
  on('challenge:vote', (p) => { rooms.vote(socket, p); });
  on('round:next', () => { rooms.nextRound(socket); });
  on('game:restart', () => { rooms.restart(socket); });

  socket.on('disconnect', () => rooms.handleDisconnect(socket));
});

server.listen(PORT, () => {
  console.log(`🎲 Όνομα-Ζώο-Φυτό-Πράγμα στο http://localhost:${PORT}`);
  console.log(`   LLM έλεγχος: ${llm.isEnabled() ? 'ενεργός' : 'ανενεργός (λείπει ANTHROPIC_API_KEY)'}`);
});

const express = require('express');
const http = require('http');
const cors = require('cors');
const bcrypt = require('bcrypt');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Simple in-memory user store. Replace with DB in production.
const USERS = {
  HB: { passwordHash: bcrypt.hashSync('hb_pass_123', 10), publicKey: null, lastSeen: null },
  KEERIPULLAA: { passwordHash: bcrypt.hashSync('keerip_pass_123', 10), publicKey: null, lastSeen: null }
};

// In-memory message store
const MESSAGES = [];

// REST login endpoint
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = USERS[username];
  if (!user) return res.status(401).json({ ok: false, message: 'unknown user' });
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ ok: false, message: 'invalid password' });
  return res.json({ ok: true, username });
});

// Get messages after a timestamp
app.get('/messages', (req, res) => {
  const since = Number(req.query.since || 0);
  const filtered = MESSAGES.filter(m => m.ts > since);
  res.json({ ok: true, messages: filtered });
});

// Socket.IO real-time handling
const sockets = {}; // username -> socket.id

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('auth', ({ username }) => {
    socket.username = username;
    sockets[username] = socket.id;
    io.emit('presence', { user: username, online: true });

    // Send stored public key of other user if available
    const otherUser = Object.keys(USERS).find(u => u !== username);
    if (otherUser && USERS[otherUser].publicKey) {
      socket.emit('otherPublicKey', { username: otherUser, publicKey: USERS[otherUser].publicKey });
    }
  });

  socket.on('setPublicKey', ({ username, publicKey }) => {
    if (USERS[username]) USERS[username].publicKey = publicKey;

    const otherUser = Object.keys(USERS).find(u => u !== username);
    if (otherUser && sockets[otherUser]) {
      io.to(sockets[otherUser]).emit('otherPublicKey', { username, publicKey });
    }
  });

  socket.on('sendMessage', (msg) => {
    MESSAGES.push(msg);
    if (sockets[msg.to]) io.to(sockets[msg.to]).emit('message', msg);
    socket.emit('sentAck', { id: msg.id, delivered: !!sockets[msg.to] });
  });

  socket.on('typing', ({ to, from }) => {
    if (sockets[to]) io.to(sockets[to]).emit('typing', { from });
  });

  socket.on('message_read', ({ id, reader }) => {
    const msg = MESSAGES.find(m => m.id === id);
    if (!msg) return;
    msg.meta = msg.meta || {};
    msg.meta.readBy = msg.meta.readBy || [];
    if (!msg.meta.readBy.includes(reader)) msg.meta.readBy.push(reader);
    if (sockets[msg.from]) io.to(sockets[msg.from]).emit('message_read', { id, reader });
  });

  socket.on('disconnect', () => {
    if (socket.username) {
      USERS[socket.username].lastSeen = Date.now();
      delete sockets[socket.username];
      io.emit('presence', { user: socket.username, online: false, lastSeen: USERS[socket.username].lastSeen });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));
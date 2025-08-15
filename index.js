const express = require('express');
const http = require('http');
const cors = require('cors');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// Simple in-memory user store. Replace with DB in production.
const USERS = {
  HB: { passwordHash: bcrypt.hashSync('hb_pass_123', 10), publicKey: null, lastSeen: null },
  KEERIPULLAA: { passwordHash: bcrypt.hashSync('keerip_pass_123', 10), publicKey: null, lastSeen: null }
};

// In-memory message store
const MESSAGES = [];

const upload = multer({ dest: UPLOAD_DIR });

// REST login endpoint
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const u = USERS[username];
  if (!u) {
    console.log(`Login failed: Unknown user ${username}`);
    return res.status(401).json({ ok: false, message: 'unknown user' });
  }
  const ok = await bcrypt.compare(password, u.passwordHash);
  if (!ok) {
    console.log(`Login failed: Invalid password for user ${username}`);
    return res.status(401).json({ ok: false, message: 'invalid password' });
  }
  console.log(`User logged in successfully: ${username}`);
  return res.json({ ok: true, username });
});

// File upload endpoint
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    console.log('File upload failed: No file received');
    return res.status(400).json({ ok: false });
  }
  console.log(`File uploaded: ${req.file.originalname} (saved as ${req.file.filename})`);
  return res.json({ ok: true, fileId: req.file.filename, originalName: req.file.originalname });
});

// Serve uploaded ciphertext files
app.get('/uploads/:id', (req, res) => {
  const id = req.params.id;
  const filePath = path.join(UPLOAD_DIR, id);
  if (!fs.existsSync(filePath)) {
    console.log(`File not found: ${id}`);
    return res.status(404).send('Not found');
  }
  res.sendFile(filePath);
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
    console.log(`User authenticated: ${username} (socket ${socket.id})`);
    io.emit('presence', { user: username, online: true });

    // When user authenticates, if other user has public key, send it immediately for key exchange
    const otherUser = Object.keys(USERS).find(u => u !== username);
    if (otherUser && USERS[otherUser].publicKey) {
      socket.emit('otherPublicKey', { username: otherUser, publicKey: USERS[otherUser].publicKey });
      console.log(`Sent stored public key of ${otherUser} to ${username} on auth`);
    }
  });

  socket.on('setPublicKey', ({ username, publicKey }) => {
    if (USERS[username]) {
      USERS[username].publicKey = publicKey;
      console.log(`Public key set for ${username}`);
    }

    // Forward this public key to the other user (if connected)
    const otherUser = Object.keys(USERS).find(u => u !== username);
    if (otherUser) {
      const otherSocketId = sockets[otherUser];
      if (otherSocketId) {
        io.to(otherSocketId).emit('otherPublicKey', { username, publicKey });
        console.log(`Forwarded public key from ${username} to ${otherUser}`);
      } else {
        console.log(`Other user ${otherUser} not connected; cannot forward public key`);
      }
    }
  });

  socket.on('sendMessage', (env) => {
    console.log(`Message received from ${env.from} to ${env.to}`, env);
    MESSAGES.push(env);

    const recipientSocketId = sockets[env.to];
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('message', env);
      console.log(`Message sent from ${env.from} to ${env.to}`);
    } else {
      console.log(`Recipient ${env.to} is offline. Message saved but not sent.`);
    }

    socket.emit('sentAck', { id: env.id, delivered: !!recipientSocketId });
  });

  socket.on('typing', ({ to, from }) => {
    const recipientSocketId = sockets[to];
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('typing', { from });
      console.log(`Typing event sent from ${from} to ${to}`);
    }
  });

  socket.on('message_read', ({ id, reader }) => {
    const msg = MESSAGES.find(m => m.id === id);
    if (msg) {
      msg.meta = msg.meta || {};
      msg.meta.readBy = msg.meta.readBy || [];
      if (!msg.meta.readBy.includes(reader)) {
        msg.meta.readBy.push(reader);
      }
      const senderSocketId = sockets[msg.from];
      if (senderSocketId) {
        io.to(senderSocketId).emit('message_read', { id, reader });
        console.log(`Message read notification sent to ${msg.from} by ${reader}`);
      }
    }
  });

  socket.on('disconnect', () => {
    if (socket.username) {
      USERS[socket.username].lastSeen = Date.now();
      delete sockets[socket.username];
      io.emit('presence', { user: socket.username, online: false, lastSeen: USERS[socket.username].lastSeen });
      console.log(`User disconnected: ${socket.username}`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Redis = require('redis');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(rateLimit({ windowMs: 60000, max: 100, message: 'Too many requests.' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const redis = Redis.createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
redis.on('error', (err) => console.error('Redis error:', err.message));
redis.connect().then(() => console.log('Connected to Redis')).catch(err => console.error('Redis connect failed:', err.message));

const BUBBLE_TTL = 300;
const COOLDOWN_TTL = 300;
let connectedUsers = 0;

io.on('connection', async (socket) => {
  connectedUsers++;
  io.emit('users:count', connectedUsers);

  try {
    const keys = await redis.keys('bubble:*');
    for (const key of keys) {
      const data = await redis.get(key);
      if (data) {
        const bubble = JSON.parse(data);
        const ttl = await redis.ttl(key);
        bubble.remainingMs = ttl * 1000;
        socket.emit('bubble:existing', bubble);
      }
    }
  } catch (err) {
    console.error('Error loading bubbles:', err.message);
  }

  socket.on('bubble:create', async (data) => {
    try {
      if (!data || !data.name || !data.text || !data.x || !data.y) {
        socket.emit('bubble:error', { message: 'Missing fields.' });
        return;
      }
      const userIP = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
      const cooldownKey = 'cooldown:' + userIP;
      const onCooldown = await redis.get(cooldownKey);
      if (onCooldown) {
        const ttl = await redis.ttl(cooldownKey);
        socket.emit('bubble:cooldown', { remainingSeconds: ttl });
        return;
      }
      const bubble = {
        id: socket.id + '-' + Date.now(),
        name: String(data.name).substring(0, 20).trim(),
        text: String(data.text).substring(0, 280).trim(),
        x: Math.max(0, Math.min(4000, Number(data.x))),
        y: Math.max(0, Math.min(3000, Number(data.y))),
        type: data.type === 'thought' ? 'thought' : 'speech',
        createdAt: Date.now()
      };
      await redis.setEx('bubble:' + bubble.id, BUBBLE_TTL, JSON.stringify(bubble));
      await redis.setEx(cooldownKey, COOLDOWN_TTL, '1');
      bubble.remainingMs = BUBBLE_TTL * 1000;
      io.emit('bubble:new', bubble);
      console.log('New bubble from "' + bubble.name + '"');
    } catch (err) {
      console.error('Error:', err.message);
      socket.emit('bubble:error', { message: 'Something went wrong.' });
    }
  });

  socket.on('disconnect', () => {
    connectedUsers--;
    io.emit('users:count', connectedUsers);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('');
  console.log('=================================');
  console.log('  Parlanonimo is running!');
  console.log('  Open: http://localhost:' + PORT);
  console.log('=================================');
  console.log('');
});

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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'parlanonimo2026';
let connectedUsers = 0;
let peakUsers = 0;

// ── Admin API routes ──

// Simple password check middleware
function adminAuth(req, res, next) {
  const pw = req.query.pw || req.headers['x-admin-password'];
  if (pw !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  next();
}

// Get all message history
app.get('/admin/api/history', adminAuth, async (req, res) => {
  try {
    const messages = await redis.lRange('history:messages', 0, -1);
    const parsed = messages.map(m => {
      try { return JSON.parse(m); } catch(e) { return null; }
    }).filter(Boolean);
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get stats
app.get('/admin/api/stats', adminAuth, async (req, res) => {
  try {
    const totalAllTime = await redis.get('stats:total_messages') || '0';
    const totalToday = await redis.get('stats:today:' + getTodayKey()) || '0';
    const peak = await redis.get('stats:peak_users') || '0';
    const activeBubbleKeys = await redis.keys('bubble:*');
    res.json({
      totalAllTime: parseInt(totalAllTime),
      totalToday: parseInt(totalToday),
      peakUsers: Math.max(parseInt(peak), peakUsers),
      activeUsers: connectedUsers,
      activeBubbles: activeBubbleKeys.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get heatmap data (all historical locations)
app.get('/admin/api/heatmap', adminAuth, async (req, res) => {
  try {
    const messages = await redis.lRange('history:messages', 0, -1);
    const points = messages.map(m => {
      try {
        const p = JSON.parse(m);
        return { lat: p.x, lng: p.y, name: p.name, time: p.createdAt };
      } catch(e) { return null; }
    }).filter(Boolean);
    res.json(points);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function getTodayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

// ── Socket.IO ──

io.on('connection', async (socket) => {
  connectedUsers++;
  if (connectedUsers > peakUsers) {
    peakUsers = connectedUsers;
    redis.set('stats:peak_users', String(peakUsers)).catch(() => {});
  }
  io.emit('users:count', connectedUsers);

  // Send to admin namespace too
  io.to('admin-room').emit('admin:userCount', connectedUsers);

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

  // Admin joins a special room to get live feed
  socket.on('admin:join', (password) => {
    if (password === ADMIN_PASSWORD) {
      socket.join('admin-room');
      socket.emit('admin:joined', { success: true });
    } else {
      socket.emit('admin:joined', { success: false });
    }
  });

  socket.on('bubble:create', async (data) => {
    try {
      if (!data || !data.name || !data.text || data.x == null || data.y == null) {
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

      const lat = Number(data.x);
      const lng = Number(data.y);
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        socket.emit('bubble:error', { message: 'Invalid coordinates.' });
        return;
      }

      const bubble = {
        id: socket.id + '-' + Date.now(),
        name: String(data.name).substring(0, 20).trim(),
        text: String(data.text).substring(0, 280).trim(),
        x: lat,
        y: lng,
        type: data.type === 'thought' ? 'thought' : 'speech',
        createdAt: Date.now()
      };

      await redis.setEx('bubble:' + bubble.id, BUBBLE_TTL, JSON.stringify(bubble));
      await redis.setEx(cooldownKey, COOLDOWN_TTL, '1');

      // ── Save to permanent history ──
      await redis.rPush('history:messages', JSON.stringify(bubble));
      // Keep last 10000 messages max
      await redis.lTrim('history:messages', -10000, -1);
      // Increment counters
      await redis.incr('stats:total_messages');
      await redis.incr('stats:today:' + getTodayKey());
      // Expire daily counter after 48 hours
      await redis.expire('stats:today:' + getTodayKey(), 172800);

      bubble.remainingMs = BUBBLE_TTL * 1000;
      io.emit('bubble:new', bubble);

      // Send to admin live feed
      io.to('admin-room').emit('admin:newMessage', bubble);

      console.log('New bubble from "' + bubble.name + '" at [' + lat.toFixed(4) + ', ' + lng.toFixed(4) + ']');
    } catch (err) {
      console.error('Error:', err.message);
      socket.emit('bubble:error', { message: 'Something went wrong.' });
    }
  });

  socket.on('disconnect', () => {
    connectedUsers--;
    io.emit('users:count', connectedUsers);
    io.to('admin-room').emit('admin:userCount', connectedUsers);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('');
  console.log('=================================');
  console.log('  Parlanonimo is running!');
  console.log('  Open: http://localhost:' + PORT);
  console.log('  Admin: http://localhost:' + PORT + '/admin.html');
  console.log('=================================');
  console.log('');
});


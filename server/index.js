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
  seedMessages();
});

// ── SEED MESSAGES ──
// Plants sample bubbles so new visitors see an active map

const seedData = [
  // ── PARIS ──
  { name: 'Flaneur', text: 'The view from Sacre-Coeur at sunset is unbeatable', x: 48.8867, y: 2.3431, type: 'speech' },
  { name: 'Amelie', text: 'Best croissant in Paris? The tiny bakery on Rue des Martyrs. You are welcome.', x: 48.8782, y: 2.3387, type: 'speech' },
  { name: 'Noctis', text: 'I think the Seine is more beautiful at 3am than at noon...', x: 48.8566, y: 2.3522, type: 'thought' },
  { name: 'Voltaire', text: 'Just saw someone propose on Pont des Arts. She said yes!', x: 48.8583, y: 2.3374, type: 'speech' },
  { name: 'Lumiere', text: 'If you skip the Louvre and go to Musee d Orsay instead, you will thank me later', x: 48.8600, y: 2.3266, type: 'speech' },
  { name: 'Reve', text: 'What if Paris was always meant to be a feeling, not a place?', x: 48.8530, y: 2.3499, type: 'thought' },
  { name: 'Minuit', text: 'The jazz bar hidden behind the red door in Le Marais... unforgettable night', x: 48.8598, y: 2.3624, type: 'speech' },
  { name: 'Ciel', text: 'I come to this bench every Tuesday. Nobody knows. It is my secret spot.', x: 48.8462, y: 2.3372, type: 'thought' },

  // ── BERLIN ──
  { name: 'Wanderer', text: 'The street art in Kreuzberg keeps getting better every week', x: 52.4988, y: 13.4200, type: 'speech' },
  { name: 'Nacht', text: 'Does anyone else feel like Berlin never truly sleeps?', x: 52.5200, y: 13.4050, type: 'thought' },
  { name: 'Spree', text: 'Curry 36 is overrated. Fight me. The real currywurst is at Konnopke.', x: 52.5390, y: 13.4133, type: 'speech' },
  { name: 'Klang', text: 'Heard the most incredible busker at Warschauer Strasse today', x: 52.5057, y: 13.4490, type: 'speech' },
  { name: 'Mauer', text: 'Walking past the East Side Gallery still gives me chills every single time', x: 52.5053, y: 13.4396, type: 'thought' },
  { name: 'Fuchs', text: 'Secret tip: the rooftop bar on Torstrasse has no sign but the best view of the TV tower', x: 52.5290, y: 13.3958, type: 'speech' },
  { name: 'Nebel', text: 'I moved here 5 years ago and still discover new neighborhoods', x: 52.4870, y: 13.4250, type: 'thought' },
  { name: 'Baer', text: 'Free piano in Mauerpark on Sundays. Just show up and play. Pure magic.', x: 52.5437, y: 13.4019, type: 'speech' },

  // ── MILAN ──
  { name: 'Ombra', text: 'The aperitivo at Navigli on Friday evening is the best therapy', x: 45.4530, y: 9.1770, type: 'speech' },
  { name: 'Nebbia', text: 'I think Milan is the most underrated city in Europe. Seriously.', x: 45.4642, y: 9.1900, type: 'thought' },
  { name: 'Duomo', text: 'Climbed to the rooftop of the Duomo today. Why did I wait 10 years to do this?', x: 45.4641, y: 9.1919, type: 'speech' },
  { name: 'Freccia', text: 'The best gelato in Milano is NOT where tourists go. Try Via Savona.', x: 45.4510, y: 9.1660, type: 'speech' },
  { name: 'Silenzio', text: 'Sometimes I sit in the Biblioteca Ambrosiana just to think in silence', x: 45.4634, y: 9.1870, type: 'thought' },
  { name: 'Sole', text: 'Spring in Parco Sempione is when Milan becomes a different city entirely', x: 45.4726, y: 9.1788, type: 'speech' },
  { name: 'Eco', text: 'The vintage market in Porta Genova every last Sunday... hidden gem', x: 45.4490, y: 9.1700, type: 'speech' },
  { name: 'Luna', text: 'I left my heart somewhere between Brera and Porta Nuova', x: 45.4730, y: 9.1880, type: 'thought' },
];

async function seedMessages() {
  try {
    // Check how many active bubbles exist
    const existingKeys = await redis.keys('bubble:*');
    if (existingKeys.length >= 8) {
      console.log('Map has ' + existingKeys.length + ' active bubbles, skipping seed.');
    } else {
      console.log('Seeding map with sample messages...');
      await plantBatch();
    }
    // Keep planting new ones periodically so the map is never empty
    setInterval(async () => {
      const keys = await redis.keys('bubble:*');
      if (keys.length < 6) {
        await plantBatch();
      }
    }, 120000); // check every 2 minutes
  } catch (err) {
    console.error('Seed error:', err.message);
  }
}

async function plantBatch() {
  // Pick 8-12 random messages from the seed data
  const shuffled = [...seedData].sort(() => Math.random() - 0.5);
  const batch = shuffled.slice(0, 8 + Math.floor(Math.random() * 5));

  for (const msg of batch) {
    // Add slight random offset so they are not always in the exact same spot
    const jitterLat = (Math.random() - 0.5) * 0.005;
    const jitterLng = (Math.random() - 0.5) * 0.005;

    const bubble = {
      id: 'seed-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6),
      name: msg.name,
      text: msg.text,
      x: msg.x + jitterLat,
      y: msg.y + jitterLng,
      type: msg.type,
      createdAt: Date.now()
    };

    // Random TTL between 2-5 minutes so they expire at different times
    const ttl = 120 + Math.floor(Math.random() * 180);
    await redis.setEx('bubble:' + bubble.id, ttl, JSON.stringify(bubble));

    // Broadcast to any connected users
    bubble.remainingMs = ttl * 1000;
    io.emit('bubble:new', bubble);
  }
  console.log('Planted ' + batch.length + ' seed bubbles across Paris, Berlin & Milan');
}


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
        text: String(data.text).substring(0, 110).trim(),
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
  // ── PARIS (French) ──
  { name: 'Flaneur', text: 'La vue depuis le Sacre-Coeur au coucher du soleil, rien ne la bat', x: 48.8867, y: 2.3431, type: 'speech' },
  { name: 'Amelie', text: 'Meilleur croissant de Paris? Rue des Martyrs', x: 48.8782, y: 2.3387, type: 'speech' },
  { name: 'Noctis', text: 'La Seine est plus belle a 3h du matin...', x: 48.8566, y: 2.3522, type: 'thought' },
  { name: 'Voltaire', text: 'Demande en mariage sur le Pont des Arts. Elle a dit oui!', x: 48.8583, y: 2.3374, type: 'speech' },
  { name: 'Lumiere', text: 'Oubliez le Louvre, allez au Musee d Orsay', x: 48.8600, y: 2.3266, type: 'speech' },
  { name: 'Reve', text: 'Et si Paris etait un sentiment plutot qu un endroit?', x: 48.8530, y: 2.3499, type: 'thought' },
  { name: 'Minuit', text: 'Le bar jazz cache dans le Marais... inoubliable', x: 48.8598, y: 2.3624, type: 'speech' },
  { name: 'Ciel', text: 'Je viens sur ce banc chaque mardi. Personne ne le sait.', x: 48.8462, y: 2.3372, type: 'thought' },
  { name: 'Etoile', text: 'Les macarons de Pierre Herme valent chaque centime', x: 48.8493, y: 2.3280, type: 'speech' },
  { name: 'Brume', text: 'Le canal Saint-Martin un dimanche matin, c est la paix', x: 48.8712, y: 2.3660, type: 'speech' },
  { name: 'Vent', text: 'Quelqu un connait le speakeasy rue Oberkampf?', x: 48.8649, y: 2.3790, type: 'speech' },
  { name: 'Aurore', text: 'Le marche aux puces de Clignancourt est un tresor', x: 48.8990, y: 2.3452, type: 'speech' },
  { name: 'Plume', text: 'J ai pleure devant le Moulin Rouge. Trop de souvenirs.', x: 48.8841, y: 2.3323, type: 'thought' },
  { name: 'Nuage', text: 'Le meilleur falafel? Rue des Rosiers, sans discussion', x: 48.8574, y: 2.3584, type: 'speech' },
  { name: 'Seine', text: 'Paris la nuit depuis la Tour Eiffel. Magique.', x: 48.8584, y: 2.2945, type: 'thought' },
  { name: 'Loup', text: 'Les bouquinistes des quais vendent des tresors caches', x: 48.8530, y: 2.3440, type: 'speech' },

  // ── BERLIN (English) ──
  { name: 'Wanderer', text: 'The street art in Kreuzberg gets better every week', x: 52.4988, y: 13.4200, type: 'speech' },
  { name: 'Nacht', text: 'Does anyone else feel like Berlin never sleeps?', x: 52.5200, y: 13.4050, type: 'thought' },
  { name: 'Spree', text: 'The real currywurst is at Konnopke. Period.', x: 52.5390, y: 13.4133, type: 'speech' },
  { name: 'Klang', text: 'Incredible busker at Warschauer today', x: 52.5057, y: 13.4490, type: 'speech' },
  { name: 'Mauer', text: 'East Side Gallery still gives me chills', x: 52.5053, y: 13.4396, type: 'thought' },
  { name: 'Fuchs', text: 'Secret rooftop on Torstrasse. No sign. Best view.', x: 52.5290, y: 13.3958, type: 'speech' },
  { name: 'Nebel', text: '5 years here. Still discovering new neighborhoods.', x: 52.4870, y: 13.4250, type: 'thought' },
  { name: 'Baer', text: 'Free piano in Mauerpark on Sundays. Pure magic.', x: 52.5437, y: 13.4019, type: 'speech' },
  { name: 'Pixel', text: 'The doner at Mustafa is worth the 40 minute queue', x: 52.4897, y: 13.3880, type: 'speech' },
  { name: 'Volt', text: 'Tempelhof at sunset. Bring a beer. Thank me later.', x: 52.4730, y: 13.4010, type: 'speech' },
  { name: 'Echo', text: 'The flea market at Boxhagener Platz is underrated', x: 52.5110, y: 13.4580, type: 'speech' },
  { name: 'Storm', text: 'Berghain rejected me again but honestly the park is better', x: 52.5113, y: 13.4428, type: 'speech' },
  { name: 'Glitch', text: 'Anyone else addicted to the Vietnamese food in Dong Xuan?', x: 52.5480, y: 13.4320, type: 'speech' },
  { name: 'Drift', text: 'Tegel is gone but the memories remain', x: 52.5210, y: 13.3870, type: 'thought' },
  { name: 'Blitz', text: 'The bookshops on Oranienstrasse are disappearing', x: 52.5010, y: 13.4200, type: 'thought' },
  { name: 'Fern', text: 'Gorlitzer Park at dawn. Just me and the birds.', x: 52.4970, y: 13.4370, type: 'thought' },

  // ── MILAN (Italian) ──
  { name: 'Peppe', text: 'Ti amo Marco', x: 45.4641, y: 9.1919, type: 'speech' },
  { name: 'Salvatore', text: 'Inter e\' merda', x: 45.4780, y: 9.2040, type: 'speech' },
  { name: 'hippo', text: 'Dove si mangia il miglior risotto?', x: 45.4530, y: 9.1770, type: 'speech' },
  { name: 'Ombra', text: 'L\'aperitivo ai Navigli il venerdi sera e\' terapia', x: 45.4510, y: 9.1740, type: 'speech' },
  { name: 'Nebbia', text: 'Milano e\' la citta piu sottovalutata d\'Europa', x: 45.4642, y: 9.1900, type: 'thought' },
  { name: 'Freccia', text: 'Il miglior gelato NON e\' dove vanno i turisti', x: 45.4510, y: 9.1660, type: 'speech' },
  { name: 'Silenzio', text: 'Mi siedo alla Biblioteca Ambrosiana solo per pensare', x: 45.4634, y: 9.1870, type: 'thought' },
  { name: 'Sole', text: 'Primavera a Parco Sempione: un\'altra citta', x: 45.4726, y: 9.1788, type: 'speech' },
  { name: 'Rosso', text: 'Il tramonto dal Bosco Verticale e\' poesia', x: 45.4786, y: 9.1902, type: 'thought' },
  { name: 'Vespa', text: 'La focaccia di Princi alle 7 di mattina. Paradiso.', x: 45.4670, y: 9.1850, type: 'speech' },
  { name: 'Fumo', text: 'Chi conosce il bar segreto dietro Colonne di San Lorenzo?', x: 45.4590, y: 9.1820, type: 'speech' },
  { name: 'Dario', text: 'Forza Milan! Stasera si vince', x: 45.4780, y: 9.2050, type: 'speech' },
  { name: 'Stella', text: 'La Pinacoteca di Brera merita piu visite del Duomo', x: 45.4720, y: 9.1880, type: 'speech' },
  { name: 'Grigio', text: 'Milano sotto la pioggia ha un fascino unico', x: 45.4650, y: 9.1930, type: 'thought' },
  { name: 'Notte', text: 'Il Mercato Centrale in Stazione Centrale... che scoperta', x: 45.4860, y: 9.2040, type: 'speech' },
  { name: 'Fiore', text: 'I giardini di Via Palestro sono il mio rifugio segreto', x: 45.4730, y: 9.1970, type: 'thought' },
];

async function seedMessages() {
  try {
    const existingKeys = await redis.keys('bubble:*');
    if (existingKeys.length >= 10) {
      console.log('Map has ' + existingKeys.length + ' active bubbles, skipping seed.');
    } else {
      console.log('Seeding map with sample messages...');
      await plantBatch(true);
    }
    // Check every 5 minutes, only plant if map is getting empty
    setInterval(async () => {
      try {
        const keys = await redis.keys('bubble:*');
        if (keys.length < 6) {
          await plantBatch(false);
        }
      } catch (err) {
        console.error('Seed interval error:', err.message);
      }
    }, 300000);
  } catch (err) {
    console.error('Seed error:', err.message);
  }
}

async function plantBatch(isInitial) {
  // On initial load plant more (15-20), on refresh plant fewer (5-8)
  const shuffled = [...seedData].sort(() => Math.random() - 0.5);
  const count = isInitial ? (15 + Math.floor(Math.random() * 6)) : (5 + Math.floor(Math.random() * 4));
  const batch = shuffled.slice(0, count);

  for (const msg of batch) {
    const jitterLat = (Math.random() - 0.5) * 0.008;
    const jitterLng = (Math.random() - 0.5) * 0.008;

    const bubble = {
      id: 'seed-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6),
      name: msg.name,
      text: msg.text,
      x: msg.x + jitterLat,
      y: msg.y + jitterLng,
      type: msg.type,
      createdAt: Date.now()
    };

    // Stagger TTLs: 3-8 minutes so they don't all vanish at once
    const ttl = 180 + Math.floor(Math.random() * 300);
    await redis.setEx('bubble:' + bubble.id, ttl, JSON.stringify(bubble));

    bubble.remainingMs = ttl * 1000;
    io.emit('bubble:new', bubble);
  }
  console.log('Planted ' + batch.length + ' seed bubbles');
}


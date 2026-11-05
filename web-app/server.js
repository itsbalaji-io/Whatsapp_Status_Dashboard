const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const qrcode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;
const OPENWA_BASE_URL = process.env.OPENWA_BASE_URL || 'http://openwa-api:2785';
const OPENWA_API_KEY = process.env.OPENWA_API_KEY || 'trust-me-bro-this-is-ultra-secure-key';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Middleware
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.use('/uploads', express.static(UPLOADS_DIR));

// ==================== AUTH SYSTEM ====================

const SESSION_SECRET = process.env.SESSION_SECRET || OPENWA_API_KEY || 'default-secret-change-me';
const USERS_FILE = path.join(DATA_DIR, 'users.json');

// In-memory user store: { id: { id, username, passwordHash, role, createdAt } }
const users = new Map();
let nextUserId = 1;

// Load users from disk if present
function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      if (Array.isArray(data)) {
        for (const u of data) {
          users.set(u.id, u);
          if (u.id > nextUserId) nextUserId = u.id + 1;
        }
      }
    }
  } catch (e) {
    console.error('Failed to load users:', e.message);
  }
}

function saveUsers() {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(Array.from(users.values()), null, 2));
  } catch (e) {
    console.error('Failed to save users:', e.message);
  }
}

// Ensure the admin account exists on every boot.
// Username: admin  |  Password: your OpenWA API key (OPENWA_API_KEY env)
// If admin already exists but its password hash doesn't match the current OPENWA_API_KEY,
// the hash is updated so you can always log in with your current API key.
function bootstrapAdmin() {
  const adminPassword = process.env.OPENWA_API_KEY || 'trust-me-bro-this-is-ultra-secure-key';
  const adminExists = Array.from(users.values()).some(u => u.role === 'admin');

  if (adminExists) {
    // Verify admin's password hash matches the current OpenWA API key; update if stale
    for (const u of users.values()) {
      if (u.role === 'admin') {
        const valid = bcrypt.compareSync(adminPassword, u.passwordHash);
        if (!valid) {
          u.passwordHash = bcrypt.hashSync(adminPassword, 10);
          saveUsers();
          console.log('[Auth] Admin password hash refreshed to match current OPENWA_API_KEY');
        }
        return;
      }
    }
  }

  const passwordHash = bcrypt.hashSync(adminPassword, 10);
  const adminUser = {
    id: nextUserId++,
    username: 'admin',
    passwordHash,
    role: 'admin',
    createdAt: new Date().toISOString(),
  };
  users.set(adminUser.id, adminUser);
  saveUsers();
  console.log('[Auth] Admin account created: username=admin, password=your OpenWA API key');
}

loadUsers();
bootstrapAdmin();

// Session middleware
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false, // set true behind HTTPS
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
    name: 'openwa_dashboard_session',
  })
);

// Auth helper: require authenticated user
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized: please log in' });
  }
  next();
}

// Auth helper: require admin role
function requireAdmin(req, res, next) {
  const user = users.get(req.session.userId);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden: admin only' });
  }
  next();
}

// Get current user (without password hash)
function getPublicUser(user) {
  if (!user) return null;
  return { id: user.id, username: user.username, role: user.role, createdAt: user.createdAt };
}

// ==================== AUTH ROUTES ====================

// Login
app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const user = Array.from(users.values()).find(u => u.username === username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = bcrypt.compareSync(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    req.session.userId = user.id;
    req.session.userRole = user.role;
    return res.json({ success: true, user: getPublicUser(user) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('openwa_dashboard_session');
    return res.json({ success: true });
  });
});

// Get current session user
app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const user = users.get(req.session.userId);
  if (!user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  return res.json({ user: getPublicUser(user) });
});

// Admin: list users (no password hashes)
app.get('/api/auth/users', requireAuth, requireAdmin, (req, res) => {
  const list = Array.from(users.values()).map(getPublicUser);
  return res.json({ users: list });
});

// Admin: create a new user
app.post('/api/auth/users', requireAuth, requireAdmin, (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    if (Array.from(users.values()).some(u => u.username === username)) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const newUser = {
      id: nextUserId++,
      username,
      passwordHash,
      role: 'user',
      createdAt: new Date().toISOString(),
    };
    users.set(newUser.id, newUser);
    saveUsers();

    return res.json({ success: true, user: getPublicUser(newUser) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Admin: delete a user
app.delete('/api/auth/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const user = users.get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.role === 'admin') return res.status(403).json({ error: 'Cannot delete admin' });
  users.delete(id);
  saveUsers();
  return res.json({ success: true });
});

// ==================== PROTECT ALL OTHER API ROUTES ====================

// All /api/* routes (except /api/auth/*) require authentication
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/api/auth/')) return next();
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized: please log in' });
  }
  next();
});

// ==================== LOGIN PAGE ROUTE ====================
// Placed before the catch-all SPA fallback (defined at end of file)

app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, `${uniqueSuffix}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB
});

// MARK: - Helpers

function extractRouteFingerprint(text) {
  if (!text) return '';
  const routes = [];
  const lines = text.split('\n');

  for (const rawLine of lines) {
    const clean = rawLine.replace(/\*/g, '').trim();
    if (clean.includes('→') || clean.includes('->')) {
      const normalizedArrow = clean.replace(/->/g, '→');
      const parts = normalizedArrow.split('→');
      if (parts.length >= 2) {
        const origRaw = parts[0];
        let destRaw = parts[1].split('·')[0].split('•')[0].split('-')[0];

        const orig = origRaw.toLowerCase().replace(/[^a-z\s]/g, '').trim();
        const dest = destRaw.toLowerCase().replace(/[^a-z\s]/g, '').trim();

        if (orig && dest) {
          routes.push(`${orig}->${dest}`);
        }
      }
    }
  }

  if (routes.length > 0) {
    const uniqueSorted = Array.from(new Set(routes)).sort();
    return uniqueSorted.join('|');
  }

  const filtered = text.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (filtered.length >= 20) {
    return filtered.slice(0, 80);
  }
  return filtered;
}

function cleanSummary(caption, type = 'image') {
  if (!caption) return `Status (${type.charAt(0).toUpperCase() + type.slice(1)})`;
  const routes = [];
  for (const line of caption.split('\n')) {
    const clean = line.trim().replace(/\*/g, '');
    if (clean.includes('→') || clean.includes('->')) {
      const shortRoute = (clean.split('·')[0] || clean).trim();
      routes.push(shortRoute);
    }
  }
  if (routes.length === 1) return routes[0];
  if (routes.length > 1) return `${routes[0]} (+${routes.length - 1} more)`;
  const first = (caption.split('\n')[0] || '').trim().replace(/\*/g, '');
  return first || `Status (${type.charAt(0).toUpperCase() + type.slice(1)})`;
}

// MARK: - History Store

class HistoryStore {
  constructor() {
    this.items = [];
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(HISTORY_FILE)) {
        const data = fs.readFileSync(HISTORY_FILE, 'utf8');
        this.items = JSON.parse(data);
        this.items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      } else {
        this.items = [];
      }
    } catch (err) {
      console.error('Failed to load history:', err.message);
      this.items = [];
    }
  }

  save() {
    try {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(this.items, null, 2), 'utf8');
    } catch (err) {
      console.error('Failed to save history:', err.message);
    }
  }

  add(item) {
    this.items.unshift(item);
    this.save();
  }

  update(item) {
    const idx = this.items.findIndex(i => i.id === item.id);
    if (idx !== -1) {
      this.items[idx] = item;
      this.save();
    }
  }

  remove(id) {
    this.items = this.items.filter(i => i.id !== id);
    this.save();
  }

  clear() {
    this.items = [];
    this.save();
  }

  getStats() {
    const total = this.items.length;
    const passed = this.items.filter(i => i.status === 'passed' || (i.status !== 'failed' && i.sessionResults && i.sessionResults.some(sr => sr.status === 'passed'))).length;
    const revoked = this.items.filter(i => i.status === 'revoked' || i.status === 'partially_revoked' || (i.sessionResults && i.sessionResults.some(sr => sr.status === 'revoked'))).length;
    const failed = this.items.filter(i => i.status === 'failed' && !(i.sessionResults && i.sessionResults.some(sr => sr.status === 'passed' || sr.status === 'revoked'))).length;
    const scheduled = this.items.filter(i => i.status === 'scheduled').length;
    return { total, passed, revoked, failed, scheduled };
  }

  activeSessionsForStatus(fileName) {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const cleaned = (fileName || '').trim().toLowerCase();
    if (!cleaned) return {};

    const map = {};
    for (const item of this.items) {
      const createdTs = new Date(item.createdAt).getTime();
      if (createdTs < cutoff) continue;
      if (item.status === 'revoked') continue;
      const itemCleaned = (item.fileName || '').trim().toLowerCase();
      if (itemCleaned !== cleaned) continue;

      if (item.status === 'scheduled') {
        if (item.targetSessionIds) {
          for (const tid of item.targetSessionIds) {
            if (!map[tid]) {
              const sName = (item.targetAccountNames && item.targetAccountNames[0]) || tid;
              map[tid] = { sessionName: sName, postedAt: item.scheduledFor || item.createdAt, statusId: null };
            }
          }
        }
      } else if (item.sessionResults) {
        for (const sr of item.sessionResults) {
          if (sr.status === 'passed' && !sr.revokedAt) {
            const sid = sr.sessionId || '';
            if (sid && !map[sid]) {
              map[sid] = { sessionName: sr.name || sid, postedAt: sr.postTimestamp || item.createdAt, statusId: sr.statusId };
            }
          }
        }
      }
    }
    return map;
  }
}

const historyStore = new HistoryStore();

// MARK: - OpenWA Client Helper

async function openwaFetch(endpoint, options = {}) {
  const url = `${OPENWA_BASE_URL}${endpoint}`;
  const headers = {
    'x-api-key': OPENWA_API_KEY,
    ...(options.headers || {})
  };
  const res = await fetch(url, { ...options, headers });
  return res;
}

// MARK: - Background Scheduler

async function executeScheduledItem(item) {
  console.log(`⏰ Executing scheduled status: ${item.fileName} (${item.id})`);
  const filePath = item.filePath;
  if (!fs.existsSync(filePath)) {
    item.status = 'failed';
    item.failureReason = `File not found on disk at ${filePath}`;
    historyStore.update(item);
    return;
  }

  try {
    const fileBuffer = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const isVideo = ['mp4', 'mov'].includes(ext);
    let mimeType = 'image/jpeg';
    if (ext === 'png') mimeType = 'image/png';
    else if (ext === 'webp') mimeType = 'image/webp';
    else if (ext === 'gif') mimeType = 'image/gif';
    else if (ext === 'mp4') mimeType = 'video/mp4';
    else if (ext === 'mov') mimeType = 'video/quicktime';

    const base64Data = fileBuffer.toString('base64');
    const endpointType = isVideo ? 'send-video' : 'send-image';
    const mediaKey = isVideo ? 'video' : 'image';

    const targets = item.targetSessionIds || [];
    const sessionResults = [];
    let hadSuccess = false;

    for (const sid of targets) {
      try {
        const postRes = await openwaFetch(`/api/sessions/${sid}/status/${endpointType}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            [mediaKey]: { base64: base64Data, mimetype: mimeType },
            caption: item.caption || ''
          })
        });
        const postData = await postRes.json();
        if (postRes.ok) {
          hadSuccess = true;
          sessionResults.push({
            sessionId: sid,
            name: sid,
            status: 'passed',
            statusId: postData.statusId || null,
            postTimestamp: new Date().toISOString()
          });
        } else {
          sessionResults.push({
            sessionId: sid,
            name: sid,
            status: 'failed',
            error: postData.message || `HTTP ${postRes.status}`,
            postTimestamp: new Date().toISOString()
          });
        }
      } catch (err) {
        sessionResults.push({
          sessionId: sid,
          name: sid,
          status: 'failed',
          error: err.message,
          postTimestamp: new Date().toISOString()
        });
      }
      // Pacing delay 300ms
      await new Promise(r => setTimeout(r, 300));
    }

    item.sessionResults = sessionResults;
    item.status = hadSuccess ? 'passed' : 'failed';
    historyStore.update(item);
    console.log(`✅ Scheduled status finished with status: ${item.status}`);
  } catch (err) {
    item.status = 'failed';
    item.failureReason = err.message;
    historyStore.update(item);
  }
}

setInterval(() => {
  const now = Date.now();
  const dueItems = historyStore.items.filter(
    i => i.status === 'scheduled' && i.scheduledFor && new Date(i.scheduledFor).getTime() <= now
  );
  for (const item of dueItems) {
    executeScheduledItem(item);
  }
}, 10000);

// MARK: - Routes

// 1. Health / Gateway Status
app.get('/api/health', async (req, res) => {
  try {
    const response = await openwaFetch('/api/sessions');
    if (!response.ok) {
      return res.json({
        gateway: 'error',
        gatewayUrl: OPENWA_BASE_URL,
        message: `Gateway returned ${response.status}`,
        readySessions: 0,
        totalSessions: 0
      });
    }
    const sessions = await response.json();
    const ready = Array.isArray(sessions) ? sessions.filter(s => s.status === 'ready').length : 0;
    return res.json({
      gateway: 'online',
      gatewayUrl: OPENWA_BASE_URL,
      readySessions: ready,
      totalSessions: Array.isArray(sessions) ? sessions.length : 0
    });
  } catch (err) {
    return res.json({
      gateway: 'offline',
      gatewayUrl: OPENWA_BASE_URL,
      message: err.message,
      readySessions: 0,
      totalSessions: 0
    });
  }
});

// 2. Sessions Management
app.get('/api/sessions', async (req, res) => {
  try {
    const response = await openwaFetch('/api/sessions');
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions', async (req, res) => {
  try {
    const { name } = req.body;
    const response = await openwaFetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions/:id/start', async (req, res) => {
  try {
    const response = await openwaFetch(`/api/sessions/${req.params.id}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    const data = await response.json().catch(() => ({}));
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions/:id/stop', async (req, res) => {
  try {
    const response = await openwaFetch(`/api/sessions/${req.params.id}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    const data = await response.json().catch(() => ({}));
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions/:id/restart', async (req, res) => {
  try {
    const id = req.params.id;
    await openwaFetch(`/api/sessions/${id}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
    await new Promise(r => setTimeout(r, 1200));
    const response = await openwaFetch(`/api/sessions/${id}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await response.json().catch(() => ({}));
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions/:id/logout', async (req, res) => {
  try {
    const response = await openwaFetch(`/api/sessions/${req.params.id}/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    const data = await response.json().catch(() => ({}));
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sessions/:id', async (req, res) => {
  try {
    const response = await openwaFetch(`/api/sessions/${req.params.id}`, { method: 'DELETE' });
    const data = await response.json().catch(() => ({}));
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions/:id/qr', async (req, res) => {
  try {
    const response = await openwaFetch(`/api/sessions/${req.params.id}/qr`);
    const data = await response.json();
    if (data.qrCode) {
      // If qrCode is raw text rather than base64/dataURL, generate dataURL
      if (!data.qrCode.startsWith('data:image/')) {
        try {
          const qrDataUrl = await qrcode.toDataURL(data.qrCode, { width: 280, margin: 2 });
          data.renderedQr = qrDataUrl;
        } catch (e) {
          // ignore
        }
      }
    }
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions/:id/pairing-code', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    const response = await openwaFetch(`/api/sessions/${req.params.id}/pairing-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber })
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions/start-all', async (req, res) => {
  try {
    const sRes = await openwaFetch('/api/sessions');
    const sessions = await sRes.json();
    const nonReady = sessions.filter(s => s.status !== 'ready');
    let started = 0;
    for (const s of nonReady) {
      await openwaFetch(`/api/sessions/${s.id}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
      started++;
    }
    res.json({ success: true, count: started });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions/stop-all', async (req, res) => {
  try {
    const sRes = await openwaFetch('/api/sessions');
    const sessions = await sRes.json();
    const running = sessions.filter(s => s.status !== 'disconnected');
    let stopped = 0;
    for (const s of running) {
      await openwaFetch(`/api/sessions/${s.id}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
      stopped++;
    }
    res.json({ success: true, count: stopped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions/restart-non-ready', async (req, res) => {
  try {
    const sRes = await openwaFetch('/api/sessions');
    const sessions = await sRes.json();
    const nonReady = sessions.filter(s => s.status !== 'ready');
    let count = 0;
    for (const s of nonReady) {
      await openwaFetch(`/api/sessions/${s.id}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
      await new Promise(r => setTimeout(r, 500));
      await openwaFetch(`/api/sessions/${s.id}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
      count++;
    }
    res.json({ success: true, count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Media Proxy (streams image/video with auth header & in-memory cache)
const mediaCache = new Map();
const MAX_MEDIA_CACHE_ITEMS = 300;

app.get('/api/media-proxy', async (req, res) => {
  try {
    const mediaPath = req.query.url;
    if (!mediaPath) return res.status(400).send('Missing url parameter');
    const targetUrl = mediaPath.startsWith('http') ? mediaPath : `${OPENWA_BASE_URL}${mediaPath}`;

    // Check memory cache
    const cached = mediaCache.get(targetUrl);
    if (cached && (Date.now() - cached.timestamp < 3600000)) {
      res.setHeader('Content-Type', cached.contentType);
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.send(cached.buffer);
    }

    const proxyRes = await fetch(targetUrl, {
      headers: { 'x-api-key': OPENWA_API_KEY }
    });
    if (!proxyRes.ok) return res.status(proxyRes.status).send('Failed to fetch media');
    const contentType = proxyRes.headers.get('content-type') || 'application/octet-stream';
    const arrayBuffer = await proxyRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (mediaCache.size >= MAX_MEDIA_CACHE_ITEMS) {
      const firstKey = mediaCache.keys().next().value;
      mediaCache.delete(firstKey);
    }
    mediaCache.set(targetUrl, { buffer, contentType, timestamp: Date.now() });

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(buffer);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// 4. Live Statuses Query & Management
app.get('/api/live-statuses', async (req, res) => {
  try {
    const sRes = await openwaFetch('/api/sessions');
    if (!sRes.ok) return res.json({ statuses: [] });
    const sessions = await sRes.json();
    const readySessions = sessions.filter(s => s.status === 'ready' && s.phone);

    const allResults = [];
    const now = Date.now();

    // Bounded concurrency pool of 3
    const concurrency = 3;
    for (let i = 0; i < readySessions.length; i += concurrency) {
      const chunk = readySessions.slice(i, i + concurrency);
      await Promise.all(
        chunk.map(async s => {
          try {
            const stRes = await openwaFetch(`/api/sessions/${s.id}/status`);
            if (!stRes.ok) return;
            const data = await stRes.json();
            const rawStatuses = data.statuses || [];

            for (const st of rawStatuses) {
              const contact = st.contact || {};
              const contactId = contact.id || '';
              // Match own account statuses
              if (contactId.includes(s.phone)) {
                const statusId = st.id || '';
                const type = st.type || 'image';
                const caption = st.caption || '';
                const mediaUrl = st.mediaUrl || null;
                const timestamp = st.timestamp ? new Date(st.timestamp) : new Date();
                const expiresAt = st.expiresAt ? new Date(st.expiresAt) : new Date(timestamp.getTime() + 24 * 3600 * 1000);

                // Exclude expired
                if (expiresAt.getTime() < now) continue;

                const origin = statusId.startsWith('3EB0') ? '🖥️ Desktop' : '📱 Phone';
                const dupKey = extractRouteFingerprint(caption);

                allResults.push({
                  id: statusId,
                  sessionId: s.id,
                  sessionName: s.name,
                  phone: s.phone,
                  pushName: s.pushName || s.name,
                  type,
                  caption,
                  mediaUrl,
                  timestamp: timestamp.toISOString(),
                  expiresAt: expiresAt.toISOString(),
                  origin,
                  duplicateKey: dupKey,
                  cleanSummary: cleanSummary(caption, type),
                  isDuplicate: false,
                  duplicateRepeatCount: 1
                });
              }
            }
          } catch (e) {
            // ignore individual session error
          }
        })
      );
      // Small pause between batches
      if (i + concurrency < readySessions.length) {
        await new Promise(r => setTimeout(r, 100));
      }
    }

    // Detect same-account duplicates
    const perSessionGroups = {};
    for (let i = 0; i < allResults.length; i++) {
      const item = allResults[i];
      if (item.duplicateKey) {
        const key = `${item.sessionId}:${item.duplicateKey}`;
        if (!perSessionGroups[key]) perSessionGroups[key] = [];
        perSessionGroups[key].push(i);
      }
    }

    for (const key in perSessionGroups) {
      const indices = perSessionGroups[key];
      if (indices.length > 1) {
        for (const idx of indices) {
          allResults[idx].isDuplicate = true;
          allResults[idx].duplicateRepeatCount = indices.length;
        }
      }
    }

    allResults.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json({ statuses: allResults });
  } catch (err) {
    res.status(500).json({ error: err.message, statuses: [] });
  }
});

app.delete('/api/live-statuses/:sessionId/:statusId', async (req, res) => {
  try {
    const { sessionId, statusId } = req.params;
    const encoded = encodeURIComponent(statusId);
    const response = await openwaFetch(`/api/sessions/${sessionId}/status/${encoded}`, {
      method: 'DELETE'
    });
    if (response.ok || response.status === 404) {
      res.json({ success: true });
    } else {
      const errText = await response.text();
      res.status(response.status).json({ success: false, error: errText });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Broadcast / Push / Schedule
app.post('/api/broadcast', upload.single('media'), async (req, res) => {
  try {
    let { caption, targetSessionIds, isScheduled, scheduledFor, existingFilePath, mediaUrl } = req.body;
    if (typeof targetSessionIds === 'string') {
      try { targetSessionIds = JSON.parse(targetSessionIds); } catch (e) { targetSessionIds = []; }
    }

    let filePath = '';
    let fileName = '';

    if (req.file) {
      filePath = req.file.path;
      fileName = req.file.originalname;
    } else if (existingFilePath && fs.existsSync(existingFilePath)) {
      filePath = existingFilePath;
      fileName = path.basename(existingFilePath);
    } else if (mediaUrl) {
      try {
        const targetUrl = mediaUrl.startsWith('http') ? mediaUrl : `${OPENWA_BASE_URL}${mediaUrl}`;
        const mRes = await fetch(targetUrl, { headers: { 'x-api-key': OPENWA_API_KEY } });
        if (mRes.ok) {
          const contentType = mRes.headers.get('content-type') || 'image/jpeg';
          let extGuess = '.jpg';
          if (contentType.includes('png')) extGuess = '.png';
          else if (contentType.includes('mp4')) extGuess = '.mp4';
          else if (contentType.includes('webp')) extGuess = '.webp';
          else if (contentType.includes('gif')) extGuess = '.gif';
          fileName = `status-${Date.now()}${extGuess}`;
          filePath = path.join(UPLOADS_DIR, fileName);
          const buf = Buffer.from(await mRes.arrayBuffer());
          fs.writeFileSync(filePath, buf);
        } else {
          return res.status(400).json({ error: 'Failed to fetch existing status media from WhatsApp.' });
        }
      } catch (err) {
        return res.status(500).json({ error: `Could not load media: ${err.message}` });
      }
    } else {
      return res.status(400).json({ error: 'No media file provided.' });
    }

    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const isVideo = ['mp4', 'mov'].includes(ext);

    // If scheduled
    if (isScheduled === 'true' || isScheduled === true) {
      const item = {
        id: 'item-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6),
        createdAt: new Date().toISOString(),
        scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : new Date(Date.now() + 3600000).toISOString(),
        fileName,
        filePath,
        caption: caption || '',
        status: 'scheduled',
        sessionResults: [],
        targetSessionIds: targetSessionIds || []
      };
      historyStore.add(item);
      return res.json({ success: true, scheduled: true, item });
    }

    // Immediate Broadcast
    const fileBuffer = fs.readFileSync(filePath);
    const base64Data = fileBuffer.toString('base64');
    let mimeType = 'image/jpeg';
    if (ext === 'png') mimeType = 'image/png';
    else if (ext === 'webp') mimeType = 'image/webp';
    else if (ext === 'gif') mimeType = 'image/gif';
    else if (ext === 'mp4') mimeType = 'video/mp4';
    else if (ext === 'mov') mimeType = 'video/quicktime';

    const endpointType = isVideo ? 'send-video' : 'send-image';
    const mediaKey = isVideo ? 'video' : 'image';

    const sessionResults = [];
    let hadSuccess = false;

    // Fetch session details for naming
    const sRes = await openwaFetch('/api/sessions');
    const sessions = await sRes.json().catch(() => []);
    const sessionsMap = {};
    if (Array.isArray(sessions)) {
      for (const s of sessions) sessionsMap[s.id] = s;
    }

    for (const sid of targetSessionIds) {
      const s = sessionsMap[sid] || { name: sid, phone: '' };
      const displayName = s.pushName ? `${s.pushName} (+${s.phone})` : (s.phone ? `+${s.phone}` : s.name);

      try {
        const postRes = await openwaFetch(`/api/sessions/${sid}/status/${endpointType}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            [mediaKey]: { base64: base64Data, mimetype: mimeType },
            caption: caption || ''
          })
        });

        const postData = await postRes.json().catch(() => ({}));
        if (postRes.ok) {
          hadSuccess = true;
          sessionResults.push({
            sessionId: sid,
            phone: s.phone || '',
            name: displayName,
            status: 'passed',
            statusId: postData.statusId || null,
            postTimestamp: new Date().toISOString()
          });
        } else {
          sessionResults.push({
            sessionId: sid,
            phone: s.phone || '',
            name: displayName,
            status: 'failed',
            error: postData.message || `HTTP ${postRes.status}`,
            postTimestamp: new Date().toISOString()
          });
        }
      } catch (err) {
        sessionResults.push({
          sessionId: sid,
          phone: s.phone || '',
          name: displayName,
          status: 'failed',
          error: err.message,
          postTimestamp: new Date().toISOString()
        });
      }
      // 300ms pacing between session dispatches
      await new Promise(r => setTimeout(r, 300));
    }

    const historyItem = {
      id: 'item-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6),
      createdAt: new Date().toISOString(),
      fileName,
      filePath,
      caption: caption || '',
      status: hadSuccess ? 'passed' : 'failed',
      sessionResults,
      targetSessionIds,
      targetAccountNames: targetSessionIds.map(id => sessionsMap[id]?.name || id)
    };
    historyStore.add(historyItem);

    res.json({
      success: hadSuccess,
      scheduled: false,
      item: historyItem,
      results: sessionResults
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. History Management
app.get('/api/history', (req, res) => {
  const stats = historyStore.getStats();
  res.json({
    stats,
    items: historyStore.items
  });
});

// Export broadcast history as CSV or JSON
app.get('/api/history/export', (req, res) => {
  try {
    const format = (req.query.format || 'csv').toLowerCase();
    const items = historyStore.items;

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="whatsapp-status-history-${new Date().toISOString().slice(0, 10)}.json"`);
      return res.json(items);
    }

    // Default: CSV
    const headers = ['id', 'createdAt', 'fileName', 'caption', 'status', 'scheduledFor', 'targetSessionIds', 'sessionResults'];
    const rows = items.map(item => {
      const sessionResults = (item.sessionResults || []).map(sr => `${sr.sessionId}:${sr.status}`).join('; ');
      return [
        item.id || '',
        item.createdAt || '',
        (item.fileName || '').replace(/"/g, '""'),
        (item.caption || '').replace(/"/g, '""'),
        item.status || '',
        item.scheduledFor || '',
        (item.targetSessionIds || []).join(', '),
        sessionResults.replace(/"/g, '""')
      ];
    });

    const csvLines = [
      headers.join(','),
      ...rows.map(row => row.map(field => {
        const str = String(field);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      }).join(','))
    ];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="whatsapp-status-history-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csvLines.join('\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/history/:id/revoke', async (req, res) => {
  try {
    const item = historyStore.items.find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const candidates = (item.sessionResults || []).filter(
      sr => sr.status === 'passed' && sr.statusId
    );

    if (candidates.length === 0) {
      return res.status(400).json({ error: 'No active statuses found to revoke' });
    }

    let successCount = 0;
    let failCount = 0;
    const sessionOutcomes = {};

    for (const sr of candidates) {
      try {
        const encoded = encodeURIComponent(sr.statusId);
        const delRes = await openwaFetch(`/api/sessions/${sr.sessionId}/status/${encoded}`, {
          method: 'DELETE'
        });
        if (delRes.ok || delRes.status === 404) {
          successCount++;
          sr.status = 'revoked';
          sr.revokedAt = new Date().toISOString();
          sessionOutcomes[sr.sessionId] = { success: true };
        } else {
          failCount++;
          const errText = await delRes.text();
          sr.revokeError = errText;
          sessionOutcomes[sr.sessionId] = { success: false, error: errText };
        }
      } catch (e) {
        failCount++;
        sr.revokeError = e.message;
        sessionOutcomes[sr.sessionId] = { success: false, error: e.message };
      }
      await new Promise(r => setTimeout(r, 200));
    }

    item.status = failCount === 0 ? 'revoked' : (successCount > 0 ? 'partially_revoked' : item.status);
    item.revokedAt = new Date().toISOString();
    historyStore.update(item);

    res.json({
      success: successCount > 0,
      successCount,
      failCount,
      sessionOutcomes,
      item
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/history/:id', (req, res) => {
  historyStore.remove(req.params.id);
  res.json({ success: true });
});

app.delete('/api/history', (req, res) => {
  historyStore.clear();
  res.json({ success: true });
});

// Helper for route fingerprint checking from client
app.post('/api/fingerprint', (req, res) => {
  const { caption, fileName } = req.body;
  const fp = extractRouteFingerprint(caption || '');
  const activeSessions = fileName ? historyStore.activeSessionsForStatus(fileName) : {};
  res.json({ fingerprint: fp, activeSessions });
});

// 7. Scheduled Broadcast Management
// List all pending scheduled broadcasts
app.get('/api/scheduled', (req, res) => {
  try {
    const scheduled = historyStore.items.filter(i => i.status === 'scheduled');
    res.json({ items: scheduled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel a scheduled broadcast before it executes
app.delete('/api/scheduled/:id', (req, res) => {
  try {
    const item = historyStore.items.find(i => i.id === req.params.id && i.status === 'scheduled');
    if (!item) return res.status(404).json({ error: 'Scheduled broadcast not found' });
    historyStore.remove(item.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Retry only the failed session results of a history item
app.post('/api/history/:id/retry-failed', async (req, res) => {
  try {
    const item = historyStore.items.find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'History item not found' });

    const failedResults = (item.sessionResults || []).filter(sr => sr.status === 'failed');
    if (failedResults.length === 0) {
      return res.status(400).json({ error: 'No failed sessions to retry' });
    }

    const filePath = item.filePath;
    if (!fs.existsSync(filePath)) {
      return res.status(400).json({ error: 'Media file not found on disk' });
    }

    const fileBuffer = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const isVideo = ['mp4', 'mov'].includes(ext);
    let mimeType = 'image/jpeg';
    if (ext === 'png') mimeType = 'image/png';
    else if (ext === 'webp') mimeType = 'image/webp';
    else if (ext === 'gif') mimeType = 'image/gif';
    else if (ext === 'mp4') mimeType = 'video/mp4';
    else if (ext === 'mov') mimeType = 'video/quicktime';

    const endpointType = isVideo ? 'send-video' : 'send-image';
    const mediaKey = isVideo ? 'video' : 'image';
    const base64Data = fileBuffer.toString('base64');

    const sessionResults = [...(item.sessionResults || [])];
    let hadAnySuccess = false;

    for (const sr of sessionResults) {
      if (sr.status !== 'failed') continue;
      const sid = sr.sessionId;
      try {
        const postRes = await openwaFetch(`/api/sessions/${sid}/status/${endpointType}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            [mediaKey]: { base64: base64Data, mimetype: mimeType },
            caption: item.caption || ''
          })
        });
        const postData = await postRes.json();
        if (postRes.ok) {
          sr.status = 'passed';
          sr.statusId = postData.statusId || null;
          sr.postTimestamp = new Date().toISOString();
          delete sr.error;
          hadAnySuccess = true;
        } else {
          sr.error = postData.message || `HTTP ${postRes.status}`;
          sr.postTimestamp = new Date().toISOString();
        }
      } catch (err) {
        sr.error = err.message;
        sr.postTimestamp = new Date().toISOString();
      }
      await new Promise(r => setTimeout(r, 300));
    }

    const allPassed = sessionResults.every(sr => sr.status === 'passed');
    item.status = allPassed ? 'passed' : (hadAnySuccess ? 'partially_revoked' : item.status);
    item.sessionResults = sessionResults;
    historyStore.update(item);

    res.json({
      success: hadAnySuccess,
      item,
      results: sessionResults.filter(sr => sr.status === 'failed' || sr.status === 'passed')
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SPA fallback — requires authentication (except /login which is handled above)
app.get('*', (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server — bind to all interfaces so colleagues on the same LAN can access
// via computer name (e.g. http://TALLYSERVER-PC:3000) instead of your IP address.
const DASHBOARD_BIND_HOST = process.env.BIND_HOST || '0.0.0.0';
app.listen(PORT, DASHBOARD_BIND_HOST, () => {
  console.log(`🚀 WhatsApp Status Web App running on ${DASHBOARD_BIND_HOST}:${PORT}`);
  console.log(`🔗 Connected OpenWA Gateway: ${OPENWA_BASE_URL}`);
  console.log(`📁 History storage: ${HISTORY_FILE}`);
  console.log(`🌐 Share this URL with colleagues: http://TALLYSERVER-PC:${PORT}`);
});

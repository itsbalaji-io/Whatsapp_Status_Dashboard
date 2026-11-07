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
app.use(express.static(path.join(__dirname, 'public'), { index: false, cacheControl: false }));
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
// Username: admin  |  Password: tallyantivirus123 (fixed admin password)
// If admin already exists but its password hash doesn't match, it is updated to the fixed password.
function bootstrapAdmin() {
  const adminPassword = 'tallyantivirus123';
  const adminExists = Array.from(users.values()).some(u => u.role === 'admin');

  if (adminExists) {
    // Verify admin's password hash matches the fixed password; update if stale
    for (const u of users.values()) {
      if (u.role === 'admin') {
        const valid = bcrypt.compareSync(adminPassword, u.passwordHash);
        if (!valid) {
          u.passwordHash = bcrypt.hashSync(adminPassword, 10);
          saveUsers();
          console.log('[Auth] Admin password hash refreshed to fixed password');
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
  console.log('[Auth] Admin account created: username=admin, password=tallyantivirus123');
}

loadUsers();
bootstrapAdmin();

// Session middleware — in-memory store (sessions reset on server restart)
// Cookie maxAge is 24 hours, so sessions persist during normal use.
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

// Auth helper: allow all functions for both admin and user roles
function requireAdmin(req, res, next) {
  const user = users.get(req.session.userId);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized: please log in' });
  }
  next();
}

// Get current user (without password hash)
function getPublicUser(user) {
  if (!user) return null;
  return { id: user.id, username: user.username, role: user.role, createdAt: user.createdAt };
}

// Helper: get current request username
function getReqUsername(req) {
  if (!req || !req.session) return 'admin';
  if (req.session.username) return req.session.username;
  if (req.session.userId) {
    const u = users.get(req.session.userId);
    if (u && u.username) {
      req.session.username = u.username;
      return u.username;
    }
  }
  return 'admin';
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
    req.session.username = user.username;
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

// Users: create a new user (accessible by both admin and user)
app.post('/api/auth/users', requireAuth, requireAdmin, (req, res) => {
  try {
    const { username, password, role } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    if (Array.from(users.values()).some(u => u.username === username)) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    const assignedRole = (role === 'admin') ? 'admin' : 'user';
    const passwordHash = bcrypt.hashSync(password, 10);
    const newUser = {
      id: nextUserId++,
      username,
      passwordHash,
      role: assignedRole,
      createdAt: new Date().toISOString(),
    };
    users.set(newUser.id, newUser);
    saveUsers();

    return res.json({ success: true, user: getPublicUser(newUser) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Users: delete a user (accessible by both admin and user)
app.delete('/api/auth/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const user = users.get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.username === 'admin') return res.status(403).json({ error: 'Cannot delete primary admin account' });
  users.delete(id);
  saveUsers();
  return res.json({ success: true });
});

// ==================== PROTECT ALL OTHER API ROUTES ====================

// All /api/* routes (except /api/auth/*, /api/health, /api/openwa-test) require authentication
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  if (req.path === '/health' || req.path === '/openwa-test') return next();
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

/**
 * Check whether this dashboard posted a given status on a given session.
 * Cross-references our own broadcast history: only statuses we posted (and that
 * are still live, not yet revoked) carry a statusId we can address on revoke.
 * Baileys only knows recipients for statuses its own engine posted — a status
 * posted from the phone or another node cannot be revoked through the API.
 */
function wasStatusPostedByDashboard(sessionId, statusId) {
  if (!sessionId || !statusId) return false;
  return historyStore.items.some(item =>
    (item.sessionResults || []).some(
      sr => sr.sessionId === sessionId && sr.statusId === statusId && sr.status === 'passed' && !sr.revokedAt
    )
  );
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

// MARK: - Removed Statuses Store (Tombstone tracking)
const REMOVED_STATUSES_FILE = path.join(DATA_DIR, 'removed-statuses.json');

class RemovedStatusStore {
  constructor() {
    this.ids = new Set();
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(REMOVED_STATUSES_FILE)) {
        const raw = fs.readFileSync(REMOVED_STATUSES_FILE, 'utf8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          this.ids = new Set(list.filter(Boolean));
        }
      }
    } catch (e) {
      this.ids = new Set();
    }
  }

  save() {
    try {
      fs.writeFileSync(REMOVED_STATUSES_FILE, JSON.stringify([...this.ids], null, 2), 'utf8');
    } catch (e) {
      console.error('Failed to save removed-statuses:', e.message);
    }
  }

  add(id) {
    if (!id) return;
    this.ids.add(id);
    const raw = id.includes('_') ? (id.split('_')[2] || id) : id;
    if (raw) this.ids.add(raw);
    this.save();
  }

  has(id) {
    if (!id) return false;
    if (this.ids.has(id)) return true;
    const raw = id.includes('_') ? (id.split('_')[2] || id) : id;
    return this.ids.has(raw);
  }
}

const removedStatusStore = new RemovedStatusStore();

// MARK: - Status Viewers Store (Reader Receipts & Insights)
const STATUS_VIEWERS_FILE = path.join(DATA_DIR, 'status-viewers.json');

class StatusViewersStore {
  constructor() {
    this.data = {}; // { [statusId]: { count: number, lastViewedAt?: string, viewers: [{ phone, name, jid, readAt }] } }
    this.saveTimeout = null;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(STATUS_VIEWERS_FILE)) {
        const raw = fs.readFileSync(STATUS_VIEWERS_FILE, 'utf8');
        this.data = JSON.parse(raw) || {};
      }
    } catch (e) {
      this.data = {};
    }
  }

  save() {
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => {
      try {
        fs.writeFileSync(STATUS_VIEWERS_FILE, JSON.stringify(this.data, null, 2), 'utf8');
      } catch (e) {
        console.error('Failed to save status-viewers:', e.message);
      }
    }, 1000);
  }

  normalizeId(id) {
    if (!id) return '';
    return id.includes('_') ? (id.split('_')[2] || id) : id;
  }

  recordViewer(statusId, participantJid, timestamp, contactName = '') {
    if (!statusId || !participantJid) return;
    const rawId = this.normalizeId(statusId);
    const key = rawId || statusId;

    if (!this.data[key]) {
      this.data[key] = { count: 0, viewers: [] };
    }

    const phone = (participantJid || '').replace(/\D/g, '');
    const alreadyExists = this.data[key].viewers.some(v => v.jid === participantJid || (phone && v.phone === phone));

    const readAt = timestamp
      ? new Date(typeof timestamp === 'number' && timestamp < 10000000000 ? timestamp * 1000 : timestamp).toISOString()
      : new Date().toISOString();

    if (!alreadyExists) {
      this.data[key].viewers.unshift({
        jid: participantJid,
        phone: phone || participantJid,
        name: contactName || formatPhone(phone) || 'WhatsApp Contact',
        readAt
      });
      this.data[key].count = this.data[key].viewers.length;
      this.data[key].lastViewedAt = readAt;
      this.save();
      console.log(`👁️ New status viewer recorded for ${key}: ${contactName || phone} (${this.data[key].count} total)`);
    }
  }

  getViewers(statusId) {
    if (!statusId) return { count: 0, viewers: [] };
    const rawId = this.normalizeId(statusId);
    return this.data[rawId] || this.data[statusId] || { count: 0, viewers: [] };
  }
}

const statusViewersStore = new StatusViewersStore();

// Contacts Name Cache: phone/jid -> Friendly Name
const contactsCache = new Map();

async function refreshContactsCache() {
  try {
    const sRes = await openwaFetch('/api/sessions');
    if (!sRes.ok) return;
    const sessions = await sRes.json();
    const ready = (Array.isArray(sessions) ? sessions : []).filter(s => s.status === 'ready');
    for (const s of ready) {
      try {
        const cRes = await openwaFetch(`/api/sessions/${s.id}/contacts`);
        if (cRes.ok) {
          const list = await cRes.json();
          for (const c of (Array.isArray(list) ? list : [])) {
            const phone = (c.number || c.id || '').replace(/\D/g, '');
            if (phone && c.name) {
              contactsCache.set(phone, c.name);
              contactsCache.set(c.id, c.name);
            }
          }
        }
      } catch (_) {}
    }
  } catch (_) {}
}

setTimeout(refreshContactsCache, 3000);
setInterval(refreshContactsCache, 10 * 60 * 1000);

// MARK: - OpenWA Realtime Events Gateway (Socket.IO Client)
const { io } = require('socket.io-client');
let openwaSocket = null;

function initOpenWASocket() {
  try {
    const wsUrl = `${OPENWA_BASE_URL}/events`;
    console.log(`🔌 Initializing Socket.IO connection to OpenWA at ${wsUrl}`);
    openwaSocket = io(wsUrl, {
      auth: { apiKey: OPENWA_API_KEY },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 3000,
      reconnectionAttempts: Infinity
    });

    openwaSocket.on('connect', () => {
      console.log('📡 Connected to OpenWA Realtime Events Gateway');
      openwaSocket.emit('message', {
        type: 'subscribe',
        sessionId: '*',
        events: ['*']
      });
    });

    openwaSocket.on('message.receipt', (data) => {
      handleInboundReceipt(data);
    });

    openwaSocket.on('message.revoked', (data) => {
      handleInboundRevoke(data);
    });

    // Also handle when OpenWA broadcasts as 'message' or 'event'
    openwaSocket.on('message', (frame) => {
      if (frame && frame.event === 'message.receipt') handleInboundReceipt(frame.data);
      if (frame && frame.event === 'message.revoked') handleInboundRevoke(frame.data);
    });

    openwaSocket.on('event', (eventName, data) => {
      if (eventName === 'message.receipt') handleInboundReceipt(data);
      if (eventName === 'message.revoked') handleInboundRevoke(data);
    });

    openwaSocket.on('connect_error', (err) => {
      // Quiet reconnect
    });
  } catch (err) {
    console.warn('Socket.IO init warning:', err.message);
  }
}

function handleInboundReceipt(data) {
  if (!data) return;
  const chatId = data.chatId || '';
  if (chatId === 'status@broadcast' || chatId.includes('broadcast')) {
    if (data.status === 'read' || data.status === 'played') {
      const statusId = data.messageId || data.id;
      const participant = data.participant || data.from || '';
      const phone = participant.replace(/\D/g, '');
      const name = contactsCache.get(phone) || contactsCache.get(participant) || '';
      statusViewersStore.recordViewer(statusId, participant, data.timestamp, name);
    }
  }
}

function handleInboundRevoke(data) {
  if (!data) return;
  const key = data.key || {};
  const remoteJid = key.remoteJid || data.chatId || '';
  if (remoteJid === 'status@broadcast' || remoteJid.includes('broadcast')) {
    const statusId = key.id || data.messageId || data.id;
    if (statusId) {
      console.log(`🗑️ Inbound status revoke received for ${statusId}`);
      removedStatusStore.add(statusId);
    }
  }
}

setTimeout(initOpenWASocket, 2000);

// MARK: - OpenWA Client Helper

async function openwaFetch(endpoint, options = {}) {
  const url = `${OPENWA_BASE_URL}${endpoint}`;
  const headers = {
    'x-api-key': OPENWA_API_KEY,
    ...(options.headers || {})
  };
  let res = await fetch(url, { ...options, headers });

  // Retry with backoff when OpenWA rate-limits (HTTP 429).
  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries && res.status === 429; attempt++) {
    const retryAfter = res.headers.get('retry-after');
    const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : Math.pow(2, attempt) * 1000;
    await new Promise(r => setTimeout(r, waitMs));
    res = await fetch(url, { ...options, headers });
  }

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
      // Anti-ban staggering or normal pacing
      if (targets.indexOf(sid) < targets.length - 1) {
        if (item.antiBanStagger && targets.length > 1) {
          const delaySec = Math.floor(Math.random() * (5 - 3 + 1)) + 3;
          console.log(`🛡️ Anti-ban smart stagger (scheduled): waiting ${delaySec}s before next account dispatch...`);
          await new Promise(r => setTimeout(r, delaySec * 1000));
        } else {
          await new Promise(r => setTimeout(r, 300));
        }
      }
    }

    const autoExpireAt = item.autoExpireHours
      ? new Date(Date.now() + item.autoExpireHours * 3600 * 1000).toISOString()
      : null;

    if (autoExpireAt) {
      item.autoExpireAt = autoExpireAt;
      for (const sr of sessionResults) {
        if (sr.status === 'passed') sr.autoExpireAt = autoExpireAt;
      }
    }

    item.sessionResults = sessionResults;
    item.status = hadSuccess ? 'passed' : 'failed';
    historyStore.update(item);
    console.log(`✅ Scheduled status finished with status: ${item.status}`);

    // Recurring Drip: auto-reschedule for tomorrow if repeatDaily is enabled
    if (hadSuccess && item.repeatDaily) {
      try {
        const tomorrow = new Date(item.scheduledFor);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const nextItem = {
          ...item,
          id: 'item-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6),
          createdAt: new Date().toISOString(),
          scheduledFor: tomorrow.toISOString(),
          status: 'scheduled',
          sessionResults: [],
          createdBy: item.createdBy || 'Daily Drip'
        };
        historyStore.add(nextItem);
        console.log(`🔁 Recurring drip schedule created for tomorrow: ${tomorrow.toISOString()} (${item.fileName})`);
      } catch (e) {
        console.warn('Failed to clone recurring drip item:', e.message);
      }
    }
  } catch (err) {
    item.status = 'failed';
    item.failureReason = err.message;
    historyStore.update(item);
  }
}

setInterval(() => {
  const now = Date.now();

  // 1. Due Scheduled items
  const dueItems = historyStore.items.filter(
    i => i.status === 'scheduled' && i.scheduledFor && new Date(i.scheduledFor).getTime() <= now
  );
  for (const item of dueItems) {
    executeScheduledItem(item);
  }

  // 2. Auto-Expire / Flash Sale timer sweep (auto-revoke when lifespan expires)
  for (const item of historyStore.items) {
    if (item.autoExpireAt && item.status === 'passed') {
      const expireTs = new Date(item.autoExpireAt).getTime();
      if (expireTs <= now) {
        console.log(`⚡ Auto-expiring flash sale status ${item.fileName} (${item.id})`);
        let anyRevoked = false;
        for (const sr of (item.sessionResults || [])) {
          if (sr.status === 'passed' && sr.statusId && !sr.revokedAt) {
            removedStatusStore.add(sr.statusId);
            openwaFetch(`/api/sessions/${sr.sessionId}/status/${encodeURIComponent(sr.statusId)}`, { method: 'DELETE' }).catch(() => {});
            sr.status = 'revoked';
            sr.revokedAt = new Date().toISOString();
            sr.revokeReason = 'auto_expired';
            anyRevoked = true;
          }
        }
        if (anyRevoked) {
          item.status = 'revoked';
          item.revokedAt = new Date().toISOString();
          item.revokedBy = 'Auto-Expire Sweeper';
          item.revokeReason = 'auto_expired';
          historyStore.update(item);
        }
      }
    }
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
    let hint = '';
    if (err.code === 'ECONNREFUSED') {
      hint = 'OpenWA API is not running. Start it on the server machine: cd OpenWA && PORT=2785 BIND_HOST=127.0.0.1 npm run start';
    } else if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
      hint = 'Cannot resolve OpenWA hostname. Check OPENWA_BASE_URL in your environment.';
    } else if (err.code === 'ETIMEDOUT') {
      hint = 'OpenWA request timed out. The gateway may be overloaded or starting up.';
    }
    return res.json({
      gateway: 'offline',
      gatewayUrl: OPENWA_BASE_URL,
      message: err.message,
      hint,
      readySessions: 0,
      totalSessions: 0
    });
  }
});

// Test OpenWA connectivity - returns detailed diagnostics
app.get('/api/openwa-test', async (req, res) => {
  const results = {};

  // Single probe through the shared openwaFetch helper (same path /api/health uses).
  try {
    const res1 = await openwaFetch('/api/sessions');
    const data = await res1.json();
    results.baseUrl = {
      reachable: true,
      status: res1.status,
      statusText: res1.statusText
    };
    results.sessions = {
      reachable: res1.ok,
      count: Array.isArray(data) ? data.length : 0,
      ready: Array.isArray(data) ? data.filter(s => s.status === 'ready').length : 0
    };
  } catch (err) {
    results.baseUrl = {
      reachable: false,
      code: err.code,
      message: err.message
    };
    results.sessions = {
      reachable: false,
      code: err.code,
      message: err.message
    };
  }

  const allOk = results.baseUrl?.reachable && results.sessions?.reachable;
  res.json({
    ok: allOk,
    gatewayUrl: OPENWA_BASE_URL,
    tests: results
  });
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

    // Map phone numbers to sessions
    const phoneToSession = {};
    for (const s of sessions) {
      if (s.phone) phoneToSession[s.phone.replace(/\D/g, '')] = s;
    }

    const seenIds = new Set();
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
              const statusId = st.id || '';
              if (!statusId || seenIds.has(statusId) || removedStatusStore.has(statusId)) continue;

              const contact = st.contact || {};
              const contactPhone = (contact.id || '').replace(/\D/g, '');
              const matchedSession = phoneToSession[contactPhone];
              const postedByUs = wasStatusPostedByDashboard(s.id, statusId);

              // ONLY show statuses belonging to connected session devices (ignore external contacts)
              if (!matchedSession && !postedByUs) {
                continue;
              }

              seenIds.add(statusId);

              const targetSession = matchedSession || s;
              const type = st.type || 'image';
              const caption = st.caption || '';
              const mediaUrl = st.mediaUrl || null;
              const timestamp = st.timestamp ? new Date(st.timestamp) : new Date();
              const expiresAt = st.expiresAt ? new Date(st.expiresAt) : new Date(timestamp.getTime() + 24 * 3600 * 1000);

              // Exclude expired
              if (expiresAt.getTime() < now) continue;

              const origin = statusId.startsWith('3EB0') ? '🖥️ Desktop' : '📱 Phone';
              const dupKey = extractRouteFingerprint(caption);
              const vData = statusViewersStore.getViewers(statusId);

              // Look up if this status in historyStore had autoExpireAt set
              let matchedAutoExpire = null;
              for (const hItem of historyStore.items) {
                if (hItem.sessionResults) {
                  const matchSr = hItem.sessionResults.find(sr => sr.statusId === statusId);
                  if (matchSr && matchSr.autoExpireAt) {
                    matchedAutoExpire = matchSr.autoExpireAt;
                    break;
                  }
                }
                if (hItem.autoExpireAt && (hItem.sessionResults || []).some(sr => sr.statusId === statusId)) {
                  matchedAutoExpire = hItem.autoExpireAt;
                  break;
                }
              }

              allResults.push({
                id: statusId,
                sessionId: targetSession.id,
                sessionName: targetSession.name,
                phone: targetSession.phone,
                pushName: targetSession.pushName || targetSession.name,
                type,
                caption,
                mediaUrl,
                timestamp: timestamp.toISOString(),
                expiresAt: expiresAt.toISOString(),
                origin,
                duplicateKey: dupKey,
                cleanSummary: cleanSummary(caption, type),
                isDuplicate: false,
                duplicateRepeatCount: 1,
                postedByThisDashboard: postedByUs || wasStatusPostedByDashboard(targetSession.id, statusId),
                viewersCount: vData.count || 0,
                viewers: vData.viewers || [],
                lastViewedAt: vData.lastViewedAt || null,
                autoExpireAt: matchedAutoExpire,
                isFlashSale: !!matchedAutoExpire
              });
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

    // Detect multi-account broadcast grouping across sessions
    for (const item of allResults) {
      let matchedHistoryItem = null;
      let broadcastGroupSessions = [];

      for (const hItem of historyStore.items) {
        if (hItem.sessionResults) {
          const match = hItem.sessionResults.find(sr => sr.statusId === item.id);
          if (match) {
            matchedHistoryItem = hItem;
            broadcastGroupSessions = hItem.sessionResults
              .filter(sr => sr.status === 'passed' && !sr.revokedAt)
              .map(sr => ({
                sessionId: sr.sessionId,
                sessionName: sr.name || sr.sessionId,
                phone: sr.phone || '',
                statusId: sr.statusId
              }));
            break;
          }
        }
      }

      // Fallback: cross-reference other live statuses in allResults by content/fingerprint
      if (broadcastGroupSessions.length <= 1) {
        const matches = allResults.filter(other => {
          if (other.id === item.id && other.sessionId === item.sessionId) return true;
          if (item.duplicateKey && other.duplicateKey && item.duplicateKey === other.duplicateKey) return true;
          if (item.cleanSummary && other.cleanSummary && item.cleanSummary === other.cleanSummary && !item.cleanSummary.startsWith('Status (')) return true;
          if (item.caption && other.caption && item.caption === other.caption && item.caption.trim().length > 15) return true;
          return false;
        });
        if (matches.length > 1) {
          const seenSessions = new Set();
          broadcastGroupSessions = [];
          for (const m of matches) {
            if (!seenSessions.has(m.sessionId)) {
              seenSessions.add(m.sessionId);
              broadcastGroupSessions.push({
                sessionId: m.sessionId,
                sessionName: m.sessionName,
                phone: m.phone || '',
                statusId: m.id
              });
            }
          }
        }
      }

      item.historyItemId = matchedHistoryItem ? matchedHistoryItem.id : null;
      item.broadcastGroupSessions = broadcastGroupSessions;
      item.broadcastGroupCount = broadcastGroupSessions.length;
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
    removedStatusStore.add(statusId);

    // Also mark revoked in historyStore if present
    for (const item of historyStore.items) {
      if (item.sessionResults) {
        let changed = false;
        for (const sr of item.sessionResults) {
          if (sr.statusId === statusId || (statusId && sr.statusId && (sr.statusId.includes(statusId) || statusId.includes(sr.statusId)))) {
            sr.status = 'revoked';
            sr.revokedAt = new Date().toISOString();
            changed = true;
          }
        }
        if (changed) {
          const allRevoked = item.sessionResults.every(sr => sr.status === 'revoked' || sr.status === 'failed');
          if (allRevoked) item.status = 'revoked';
          item.revokedBy = getReqUsername(req);
          item.revokedAt = new Date().toISOString();
          historyStore.update(item);
        }
      }
    }

    const encoded = encodeURIComponent(statusId);
    await openwaFetch(`/api/sessions/${sessionId}/status/${encoded}`, {
      method: 'DELETE'
    }).catch(() => {});

    // Also notify other sessions in OpenWA in case they ingested it as a contact status
    try {
      const sRes = await openwaFetch('/api/sessions');
      if (sRes.ok) {
        const allSessions = await sRes.json();
        for (const s of allSessions) {
          if (s.id !== sessionId) {
            await openwaFetch(`/api/sessions/${s.id}/status/${encoded}`, { method: 'DELETE' }).catch(() => {});
          }
        }
      }
    } catch (_) {}

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Multi-Account Batch Status Deletion: deletes a status from ALL session accounts at once
app.post('/api/live-statuses/delete-all', async (req, res) => {
  try {
    const { sessionId, statusId, historyItemId, targets } = req.body || {};
    const operator = getReqUsername(req);

    let toDelete = [];

    // 1. If explicit targets passed from client
    if (Array.isArray(targets) && targets.length > 0) {
      toDelete = targets;
    } 
    // 2. If historyItemId passed
    else if (historyItemId) {
      const hItem = historyStore.items.find(h => h.id === historyItemId);
      if (hItem && hItem.sessionResults) {
        toDelete = hItem.sessionResults
          .filter(sr => sr.statusId && sr.status !== 'revoked')
          .map(sr => ({ sessionId: sr.sessionId, statusId: sr.statusId }));
      }
    } 
    // 3. If single statusId passed, find its sister sessions
    else if (statusId) {
      for (const hItem of historyStore.items) {
        if ((hItem.sessionResults || []).some(sr => sr.statusId === statusId)) {
          toDelete = hItem.sessionResults
            .filter(sr => sr.statusId && sr.status !== 'revoked')
            .map(sr => ({ sessionId: sr.sessionId, statusId: sr.statusId }));
          break;
        }
      }
      if (toDelete.length === 0 && sessionId) {
        toDelete = [{ sessionId, statusId }];
      }
    }

    if (toDelete.length === 0) {
      return res.status(400).json({ error: 'No matching statuses found to delete across accounts' });
    }

    const deletedResults = [];
    const nowIso = new Date().toISOString();

    for (const target of toDelete) {
      const sid = target.sessionId;
      const stid = target.statusId;
      if (!sid || !stid) continue;

      // 1. Add to tombstone
      removedStatusStore.add(stid);

      // 2. Update historyStore
      for (const item of historyStore.items) {
        if (item.sessionResults) {
          let changed = false;
          for (const sr of item.sessionResults) {
            if (sr.statusId === stid || (sr.statusId && sr.statusId.includes(stid))) {
              sr.status = 'revoked';
              sr.revokedAt = nowIso;
              changed = true;
            }
          }
          if (changed) {
            const allRevoked = item.sessionResults.every(sr => sr.status === 'revoked' || sr.status === 'failed');
            if (allRevoked) item.status = 'revoked';
            item.revokedBy = operator;
            item.revokedAt = nowIso;
            historyStore.update(item);
          }
        }
      }

      // 3. Call OpenWA Baileys to delete on that specific session
      try {
        const encoded = encodeURIComponent(stid);
        await openwaFetch(`/api/sessions/${sid}/status/${encoded}`, { method: 'DELETE' });
        deletedResults.push({ sessionId: sid, statusId: stid, success: true });
      } catch (err) {
        deletedResults.push({ sessionId: sid, statusId: stid, success: false, error: err.message });
      }
      await new Promise(r => setTimeout(r, 150));
    }

    console.log(`🗑️ Multi-Account Batch Delete: removed status from ${deletedResults.length} accounts (Operator: ${operator})`);
    return res.json({
      success: true,
      deletedCount: deletedResults.length,
      results: deletedResults
    });
  } catch (err) {
    console.error('Multi-account batch delete error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Clear all live statuses across all accounts (or a specific account)
app.post('/api/live-statuses/clear-all', async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    const operator = getReqUsername(req);
    const nowIso = new Date().toISOString();

    const sRes = await openwaFetch('/api/sessions');
    if (!sRes.ok) return res.status(500).json({ error: 'Failed to list sessions' });
    const allSessions = await sRes.json();
    const readySessions = allSessions.filter(s => s.status === 'ready' && (!sessionId || s.id === sessionId));

    let deletedCount = 0;

    for (const session of readySessions) {
      try {
        const stRes = await openwaFetch(`/api/sessions/${session.id}/status`);
        if (!stRes.ok) continue;
        const stories = await stRes.json();
        if (!Array.isArray(stories)) continue;

        for (const story of stories) {
          const statusId = story.id || story.key?.id;
          if (!statusId) continue;

          removedStatusStore.add(statusId);
          deletedCount++;

          const encoded = encodeURIComponent(statusId);
          openwaFetch(`/api/sessions/${session.id}/status/${encoded}`, { method: 'DELETE' }).catch(() => {});
        }
      } catch (err) {
        console.error(`Error clearing statuses for session ${session.id}:`, err.message);
      }
    }

    // Mark any active history items as revoked
    for (const item of historyStore.items) {
      if (item.status === 'passed' && item.sessionResults) {
        let changed = false;
        for (const sr of item.sessionResults) {
          if ((!sessionId || sr.sessionId === sessionId) && sr.status === 'passed' && !sr.revokedAt) {
            sr.status = 'revoked';
            sr.revokedAt = nowIso;
            changed = true;
          }
        }
        if (changed) {
          const allRevoked = item.sessionResults.every(sr => sr.status === 'revoked' || sr.status === 'failed');
          if (allRevoked) item.status = 'revoked';
          item.revokedBy = operator;
          item.revokedAt = nowIso;
          historyStore.update(item);
        }
      }
    }

    console.log(`🗑️ Clear All Live Statuses: removed ${deletedCount} statuses (Operator: ${operator})`);
    return res.json({ success: true, count: deletedCount });
  } catch (err) {
    console.error('Clear all live statuses error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Viewers & Reader Receipts Insights Endpoint
app.get('/api/live-statuses/:statusId/viewers', (req, res) => {
  const { statusId } = req.params;
  const vData = statusViewersStore.getViewers(statusId);
  res.json({
    statusId,
    count: vData.count || 0,
    lastViewedAt: vData.lastViewedAt || null,
    viewers: vData.viewers || []
  });
});

// 5. Broadcast / Push / Schedule
app.post('/api/broadcast', upload.single('media'), async (req, res) => {
  try {
    let {
      caption,
      targetSessionIds,
      isScheduled,
      scheduledFor,
      existingFilePath,
      mediaUrl,
      antiBanStagger,
      staggerMin,
      staggerMax,
      autoExpireHours,
      repeatDaily,
      dripSlot
    } = req.body;

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
    const autoHours = parseFloat(autoExpireHours) || 0;
    const isStagger = (antiBanStagger === 'true' || antiBanStagger === true || antiBanStagger === undefined) && targetSessionIds.length > 1;
    const sMin = parseInt(staggerMin, 10) || 3;
    const sMax = parseInt(staggerMax, 10) || 5;

    // If scheduled
    if (isScheduled === 'true' || isScheduled === true) {
      const operator = getReqUsername(req);
      const item = {
        id: 'item-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6),
        createdAt: new Date().toISOString(),
        scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : new Date(Date.now() + 3600000).toISOString(),
        fileName,
        filePath,
        caption: caption || '',
        status: 'scheduled',
        sessionResults: [],
        targetSessionIds: targetSessionIds || [],
        repeatDaily: repeatDaily === 'true' || repeatDaily === true,
        dripSlot: dripSlot || null,
        autoExpireHours: autoHours > 0 ? autoHours : null,
        antiBanStagger: isStagger,
        createdBy: operator
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
    const autoExpireAt = autoHours > 0 ? new Date(Date.now() + autoHours * 3600 * 1000).toISOString() : null;

    const sessionResults = [];
    let hadSuccess = false;

    // Fetch session details for naming
    const sRes = await openwaFetch('/api/sessions');
    const sessions = await sRes.json().catch(() => []);
    const sessionsMap = {};
    if (Array.isArray(sessions)) {
      for (const s of sessions) sessionsMap[s.id] = s;
    }

    for (let idx = 0; idx < targetSessionIds.length; idx++) {
      const sid = targetSessionIds[idx];
      const s = sessionsMap[sid] || { name: sid, phone: '' };
      const displayName = s.pushName ? `${s.pushName} (+${s.phone})` : (s.phone ? `+${s.phone}` : s.name);

      // Apply anti-ban staggering between multiple accounts
      if (idx > 0 && isStagger) {
        const delaySec = Math.floor(Math.random() * (sMax - sMin + 1)) + sMin;
        console.log(`🛡️ Anti-ban smart stagger: pausing ${delaySec}s before dispatching to session ${displayName}...`);
        await new Promise(r => setTimeout(r, delaySec * 1000));
      } else if (idx > 0) {
        await new Promise(r => setTimeout(r, 300));
      }

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
            postTimestamp: new Date().toISOString(),
            autoExpireAt: autoExpireAt || undefined
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
    }

    const operator = getReqUsername(req);
    const historyItem = {
      id: 'item-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6),
      createdAt: new Date().toISOString(),
      fileName,
      filePath,
      caption: caption || '',
      status: hadSuccess ? 'passed' : 'failed',
      sessionResults,
      targetSessionIds,
      targetAccountNames: targetSessionIds.map(id => sessionsMap[id]?.name || id),
      autoExpireAt: autoExpireAt || undefined,
      autoExpireHours: autoHours > 0 ? autoHours : undefined,
      antiBanStagger: isStagger,
      createdBy: operator
    };
    historyStore.add(historyItem);

    const failedSessions = sessionResults.filter(sr => sr.status === 'failed');
    const errorMsg = failedSessions.length > 0
      ? `Partial failure: ${failedSessions.length} of ${sessionResults.length} sessions failed`
      : 'All sessions failed';

    res.json({
      success: hadSuccess,
      scheduled: false,
      error: hadSuccess ? undefined : errorMsg,
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
        removedStatusStore.add(sr.statusId);
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
    item.revokedBy = getReqUsername(req);
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
    item.lastRetriedBy = getReqUsername(req);
    item.lastRetriedAt = new Date().toISOString();
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

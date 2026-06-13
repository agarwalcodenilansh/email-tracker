const express = require('express');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');
const session = require('express-session');
require('dotenv').config();
const { google } = require('googleapis');
const path = require('path');

const app = express();
const db = new Database('tracker.db');

app.use(cors({ credentials: true, origin: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'changeme-secret-123',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(__dirname));

// ─── Database setup ───────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    gmail_user TEXT NOT NULL,
    gmail_app_password TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS emails_sent (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    to_email TEXT,
    subject TEXT,
    sent_at TEXT,
    open_count INTEGER DEFAULT 0,
    last_opened TEXT,
    replied INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS open_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id TEXT,
    opened_at TEXT,
    ip TEXT,
    user_agent TEXT
  );
  CREATE TABLE IF NOT EXISTS emails_received (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    from_email TEXT,
    subject TEXT,
    received_at TEXT,
    read_by_me INTEGER DEFAULT 0,
    replied INTEGER DEFAULT 0
  );
`);

// ─── Auth middleware ──────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
}

// ─── Auth routes ──────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { email, password, gmailUser, gmailAppPassword } = req.body;
  if (!email || !password || !gmailUser || !gmailAppPassword)
    return res.status(400).json({ error: 'All fields required' });

  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) return res.status(400).json({ error: 'Email already registered' });

  // Verify Gmail credentials work before saving
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: gmailUser, pass: gmailAppPassword }
    });
    await transporter.verify();
  } catch (e) {
    return res.status(400).json({ error: 'Gmail credentials invalid. Check your app password.' });
  }

  const id = uuidv4();
  const hash = await bcrypt.hash(password, 10);
  db.prepare('INSERT INTO users (id, email, password_hash, gmail_user, gmail_app_password) VALUES (?,?,?,?,?)')
    .run(id, email, hash, gmailUser, gmailAppPassword);

  req.session.userId = id;
  req.session.gmailUser = gmailUser;

  // Start inbox sync for this user
  startUserSync(id, gmailUser, gmailAppPassword);

  res.json({ success: true, email });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Invalid email or password' });

  req.session.userId = user.id;
  req.session.gmailUser = user.gmail_user;

  startUserSync(user.id, user.gmail_user, user.gmail_app_password);

  res.json({ success: true, email: user.email, gmailUser: user.gmail_user });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, email, gmail_user, created_at FROM users WHERE id = ?').get(req.session.userId);
  res.json(user);
});

// ─── Tracking pixel (no auth — email clients hit this) ────────
app.get('/track/open/:id', (req, res) => {
  const { id } = req.params;
  const now = new Date().toISOString();
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'] || '';

  db.prepare('INSERT INTO open_events (email_id, opened_at, ip, user_agent) VALUES (?,?,?,?)')
    .run(id, now, ip, userAgent);
  db.prepare('UPDATE emails_sent SET open_count = open_count + 1, last_opened = ? WHERE id = ?')
    .run(now, id);

  const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-store');
  res.send(pixel);
});

// ─── Send email ───────────────────────────────────────────────
app.post('/api/send', requireAuth, async (req, res) => {
  const { to, subject, body } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  const id = uuidv4();
  const now = new Date().toISOString();
  const trackingUrl = `${process.env.BASE_URL}/track/open/${id}`;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: user.gmail_user, pass: user.gmail_app_password }
  });

  const htmlBody = `
    <div style="font-family: Arial, sans-serif; font-size: 15px; line-height: 1.6;">
      ${body.replace(/\n/g, '<br/>')}
    </div>
    <img src="${trackingUrl}" width="1" height="1" style="display:none" alt=""/>
  `;

  try {
    await transporter.sendMail({ from: user.gmail_user, to, subject, html: htmlBody });
    db.prepare('INSERT INTO emails_sent (id, user_id, to_email, subject, sent_at) VALUES (?,?,?,?,?)')
      .run(id, req.session.userId, to, subject, now);
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── API: Sent emails ─────────────────────────────────────────
app.get('/api/sent', requireAuth, (req, res) => {
  const emails = db.prepare('SELECT * FROM emails_sent WHERE user_id = ? ORDER BY sent_at DESC').all(req.session.userId);
  res.json(emails);
});

// ─── API: Inbox ───────────────────────────────────────────────
app.get('/api/inbox', requireAuth, (req, res) => {
  const emails = db.prepare('SELECT * FROM emails_received WHERE user_id = ? ORDER BY received_at DESC').all(req.session.userId);
  res.json(emails);
});

// ─── API: Stats ───────────────────────────────────────────────
app.get('/api/stats', requireAuth, (req, res) => {
  const uid = req.session.userId;
  const today = new Date().toISOString().split('T')[0];
  const sent     = db.prepare(`SELECT COUNT(*) as count FROM emails_sent WHERE user_id=? AND sent_at LIKE ?`).get(uid, `${today}%`);
  const received = db.prepare(`SELECT COUNT(*) as count FROM emails_received WHERE user_id=? AND received_at LIKE ?`).get(uid, `${today}%`);
  const opened   = db.prepare(`SELECT COUNT(*) as count FROM emails_sent WHERE user_id=? AND last_opened LIKE ? AND open_count > 0`).get(uid, `${today}%`);
  const replied  = db.prepare(`SELECT COUNT(*) as count FROM emails_received WHERE user_id=? AND replied=1 AND received_at LIKE ?`).get(uid, `${today}%`);
  res.json({ sent: sent.count, received: received.count, opened: opened.count, replied: replied.count });
});

// ─── API: Open events ─────────────────────────────────────────
app.get('/api/opens/:id', requireAuth, (req, res) => {
  const events = db.prepare('SELECT * FROM open_events WHERE email_id = ? ORDER BY opened_at DESC').all(req.params.id);
  res.json(events);
});

// ─── Per-user Gmail sync ──────────────────────────────────────
const syncIntervals = {};

function getGmailClientForUser(gmailUser, gmailAppPassword) {
  // Use OAuth if env vars set, otherwise fall back to nothing (inbox sync skipped)
  if (process.env.GOOGLE_CREDENTIALS && process.env.GOOGLE_TOKEN) {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    const { client_id, client_secret } = credentials.installed || credentials.web;
    const oauth2Client = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:3001/oauth2callback');
    oauth2Client.setCredentials(JSON.parse(process.env.GOOGLE_TOKEN));
    return google.gmail({ version: 'v1', auth: oauth2Client });
  }
  return null;
}

async function syncInboxForUser(userId, gmailUser, gmailAppPassword) {
  try {
    const gmail = getGmailClientForUser(gmailUser, gmailAppPassword);
    if (!gmail) return;

    const list = await gmail.users.messages.list({ userId: 'me', labelIds: ['INBOX'], maxResults: 20 });
    const messages = list.data.messages || [];

    for (const msg of messages) {
      const exists = db.prepare('SELECT id FROM emails_received WHERE id = ? AND user_id = ?').get(msg.id, userId);
      if (exists) continue;

      const full = await gmail.users.messages.get({
        userId: 'me', id: msg.id, format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date']
      });

      const headers = full.data.payload.headers;
      const from    = headers.find(h => h.name === 'From')?.value || 'Unknown';
      const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
      const date    = headers.find(h => h.name === 'Date')?.value || new Date().toISOString();
      const readByMe = (full.data.labelIds || []).includes('UNREAD') ? 0 : 1;

      const thread = await gmail.users.threads.get({ userId: 'me', id: full.data.threadId, format: 'metadata' });
      const replied = thread.data.messages.some(m => (m.labelIds || []).includes('SENT')) ? 1 : 0;

      db.prepare('INSERT INTO emails_received (id, user_id, from_email, subject, received_at, read_by_me, replied) VALUES (?,?,?,?,?,?,?)')
        .run(msg.id, userId, from, subject, new Date(date).toISOString(), readByMe, replied);
    }
    console.log(`📥 [${gmailUser}] Inbox synced — ${messages.length} messages checked`);
  } catch (err) {
    console.error(`Inbox sync error [${gmailUser}]:`, err.message);
  }
}

function startUserSync(userId, gmailUser, gmailAppPassword) {
  if (syncIntervals[userId]) return; // already running
  syncInboxForUser(userId, gmailUser, gmailAppPassword);
  syncIntervals[userId] = setInterval(() => {
    syncInboxForUser(userId, gmailUser, gmailAppPassword);
  }, 2 * 60 * 1000);
}

// Start sync for all existing users on boot
const allUsers = db.prepare('SELECT id, gmail_user, gmail_app_password FROM users').all();
allUsers.forEach(u => startUserSync(u.id, u.gmail_user, u.gmail_app_password));

// ─── Serve pages ──────────────────────────────────────────────
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'register.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});

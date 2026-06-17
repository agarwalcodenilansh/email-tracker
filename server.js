const express = require('express');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const nodemailer = require('nodemailer');
require('dotenv').config();
const { google } = require('googleapis');

const app = express();
const db = new Database('tracker.db');

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ─── Database setup ───────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS emails_sent (
    id TEXT PRIMARY KEY,
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
    from_email TEXT,
    subject TEXT,
    received_at TEXT,
    read_by_me INTEGER DEFAULT 0,
    replied INTEGER DEFAULT 0
  );
`);

// ─── Gmail transporter ────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: "74.125.133.108",   // smtp.gmail.com IPv4 — or use "smtp4.gmail.com"
  port: 587,
  secure: false,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
  tls: {
    servername: "smtp.gmail.com",   // ← needed since we're using IP directly
    rejectUnauthorized: false
  }
});
// ─── Tracking pixel ───────────────────────────────────────────
app.get('/track/open/:id', (req, res) => {
  const { id } = req.params;
  const now = new Date().toISOString();
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'] || '';

  db.prepare(`
    INSERT INTO open_events (email_id, opened_at, ip, user_agent)
    VALUES (?, ?, ?, ?)
  `).run(id, now, ip, userAgent);

  db.prepare(`
    UPDATE emails_sent SET open_count = open_count + 1, last_opened = ?
    WHERE id = ?
  `).run(now, id);

  const pixel = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64'
  );
  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-store');
  res.send(pixel);
});

// ─── Send a real tracked email ─────────────────────────────────
app.post('/api/send', async (req, res) => {
  const { to, subject, body } = req.body;
  const id = uuidv4();
  const now = new Date().toISOString();
  const trackingUrl = `${process.env.BASE_URL}/track/open/${id}`;

  const htmlBody = `
    <div style="font-family: Arial, sans-serif; font-size: 15px; line-height: 1.6;">
      ${body.replace(/\n/g, '<br/>')}
    </div>
    <img src="${trackingUrl}" width="1" height="1" style="display:none" alt=""/>
  `;

  try {
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to,
      subject,
      html: htmlBody,
    });

    db.prepare(`
      INSERT INTO emails_sent (id, to_email, subject, sent_at)
      VALUES (?, ?, ?, ?)
    `).run(id, to, subject, now);

    res.json({ success: true, id, message: 'Email sent with tracking!' });
  } catch (err) {
    console.error('Send error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── API: Sent emails ─────────────────────────────────────────
app.get('/api/sent', (req, res) => {
  const emails = db.prepare('SELECT * FROM emails_sent ORDER BY sent_at DESC').all();
  res.json(emails);
});

// ─── API: Inbox ───────────────────────────────────────────────
app.get('/api/inbox', (req, res) => {
  const emails = db.prepare('SELECT * FROM emails_received ORDER BY received_at DESC').all();
  res.json(emails);
});

// ─── API: Daily stats ─────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const sent     = db.prepare(`SELECT COUNT(*) as count FROM emails_sent WHERE sent_at LIKE ?`).get(`${today}%`);
  const received = db.prepare(`SELECT COUNT(*) as count FROM emails_received WHERE received_at LIKE ?`).get(`${today}%`);
  const opened   = db.prepare(`SELECT COUNT(*) as count FROM emails_sent WHERE last_opened LIKE ? AND open_count > 0`).get(`${today}%`);
  const replied  = db.prepare(`SELECT COUNT(*) as count FROM emails_received WHERE replied = 1 AND received_at LIKE ?`).get(`${today}%`);
  res.json({ sent: sent.count, received: received.count, opened: opened.count, replied: replied.count });
});

// ─── API: Open events for a specific email ────────────────────
app.get('/api/opens/:id', (req, res) => {
  const events = db.prepare('SELECT * FROM open_events WHERE email_id = ? ORDER BY opened_at DESC').all(req.params.id);
  res.json(events);
});

const PORT = process.env.PORT || 3000;

// ─── Gmail inbox reader ───────────────────────────────────────
function getGmailClient() {
  // Read from environment variables instead of files
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const { client_id, client_secret } = credentials.installed || credentials.web;
  const oauth2Client = new google.auth.OAuth2(
    client_id, client_secret, 'http://localhost:3001/oauth2callback'
  );
  const token = JSON.parse(process.env.GOOGLE_TOKEN);
  oauth2Client.setCredentials(token);
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

async function syncInbox() {
  try {
    // Skip if env vars not set
    if (!process.env.GOOGLE_CREDENTIALS || !process.env.GOOGLE_TOKEN) {
      console.log('⚠️  GOOGLE_CREDENTIALS or GOOGLE_TOKEN not set — skipping inbox sync');
      return;
    }

    const gmail = getGmailClient();

    const list = await gmail.users.messages.list({
      userId: 'me',
      labelIds: ['INBOX'],
      maxResults: 20
    });

    const messages = list.data.messages || [];

    for (const msg of messages) {
      const exists = db.prepare('SELECT id FROM emails_received WHERE id = ?').get(msg.id);
      if (exists) continue;

      const full = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date']
      });

      const headers = full.data.payload.headers;
      const from    = headers.find(h => h.name === 'From')?.value || 'Unknown';
      const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
      const date    = headers.find(h => h.name === 'Date')?.value || new Date().toISOString();

      const labelIds = full.data.labelIds || [];
      const readByMe = labelIds.includes('UNREAD') ? 0 : 1;

      const thread = await gmail.users.threads.get({
        userId: 'me',
        id: full.data.threadId,
        format: 'metadata'
      });
      const replied = thread.data.messages.some(m =>
        (m.labelIds || []).includes('SENT')
      ) ? 1 : 0;

      db.prepare(`
        INSERT INTO emails_received (id, from_email, subject, received_at, read_by_me, replied)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(msg.id, from, subject, new Date(date).toISOString(), readByMe, replied);
    }

    console.log(`📥 Inbox synced — ${messages.length} messages checked`);
  } catch (err) {
    console.error('Inbox sync error:', err.message);
  }
}

syncInbox();
setInterval(syncInbox, 2 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  console.log(`📧 Sending as: ${process.env.GMAIL_USER}`);
});

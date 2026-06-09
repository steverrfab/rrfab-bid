'use strict';
const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../db');
const { sendFeedback } = require('../lib/email');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Shared secret that lets the automated triage task read/update feedback.
// Set FEEDBACK_KEY in Railway env vars. The /admin/* paths are allowed through
// requireAuth (see lib/auth.js isPublicPath) and enforce this key themselves.
function keyOk(req) {
  const want = process.env.FEEDBACK_KEY || '';
  const got = (req.query.key || req.headers['x-feedback-key'] || '').toString();
  return want.length > 0 && got === want;
}

// Submit feedback: save it for triage AND email it (existing behavior).
router.post('/', upload.single('attachment'), async (req, res) => {
  const { message, context } = req.body || {};
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message is required.' });
  }
  const u = req.user || {};
  try {
    db.prepare(
      'INSERT INTO feedback (user_id, user_name, user_email, context, message) VALUES (?,?,?,?,?)'
    ).run(u.userId || null, u.name || '', u.email || '', (context || '').trim(), message.trim());
  } catch (err) {
    // Saving feedback should never block the user; log and continue to email.
    console.error('[feedback] save failed:', err.message);
  }
  const file = req.file ? { buffer: req.file.buffer, name: req.file.originalname, type: req.file.mimetype } : null;
  const result = await sendFeedback(message.trim(), (context || '').trim(), file);
  res.json({ ok: true, email: result });
});

// --- Admin (key-protected) endpoints for the automated triage task ---

// List feedback awaiting triage (status = 'new'), oldest first.
router.get('/admin/pending', (req, res) => {
  if (!keyOk(req)) return res.status(403).json({ error: 'bad key' });
  const rows = db.prepare(
    "SELECT id, created_at, user_name, user_email, context, message, status " +
    "FROM feedback WHERE status = 'new' ORDER BY created_at ASC"
  ).all();
  res.json({ count: rows.length, feedback: rows });
});

// Update an item's status and resolution note once the task has handled it.
// Accepts POST (status/resolution in JSON body) or GET (in query string) so the
// automated task can mark items via a simple GET fetch.
function updateStatus(req, res) {
  if (!keyOk(req)) return res.status(403).json({ error: 'bad key' });
  const id = Number(req.params.id);
  const src = req.method === 'GET' ? req.query : (req.body || {});
  const status = String(src.status || '').trim();
  const resolution = String(src.resolution || '');
  const allowed = ['new', 'reviewing', 'answered', 'done'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'bad status' });
  const row = db.prepare('SELECT id FROM feedback WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  db.prepare(
    "UPDATE feedback SET status = ?, resolution = ?, handled_at = datetime('now') WHERE id = ?"
  ).run(status, resolution, id);
  res.json({ ok: true, id, status });
}
router.post('/admin/:id/status', express.json(), updateStatus);
router.get('/admin/:id/status', updateStatus);

module.exports = router;

'use strict';
const express = require('express');
const db = require('../db');
const { sendWonNotification, isConfigured, graphConfigured } = require('../lib/email');

const router = express.Router();

// POST /api/recipients/test
// Sends a Job Won email to the signed-in admin only, so email can be verified
// without marking a real bid Won and without mailing the whole shop. Uses the
// real Won template against a real bid so it exercises the exact code path that
// runs in production, and waits for the send so the caller gets the true result
// (including the provider's error text) instead of a fire-and-forget guess.
router.post('/test', async (req, res) => {
  const to = String((req.user && req.user.email) || '').trim();
  if (!to) {
    return res.status(400).json({ error: 'Your account has no email address on file.' });
  }
  if (!isConfigured()) {
    return res.status(503).json({
      error: 'Email is not configured on the server. Set the AZURE_* (Graph) or SMTP_* variables on Railway.'
    });
  }

  // Prefer a Won bid so the sample numbers look realistic; fall back to the
  // newest bid of any status.
  const row = db.prepare(`
    SELECT id FROM estimates
    WHERE deleted_at IS NULL AND is_alternate = 0 AND change_order_id IS NULL
    ORDER BY (status = 'Won') DESC, id DESC
    LIMIT 1
  `).get();
  if (!row) {
    return res.status(400).json({ error: 'No bids exist yet to build a sample email from.' });
  }

  let bundle;
  try {
    // Lazy require: server.js mounts /api/estimates first, so this is already
    // in the module cache, and loading it here avoids a load-order dependency.
    const { loadFullEstimate } = require('./estimates');
    bundle = loadFullEstimate(row.id);
  } catch (err) {
    return res.status(500).json({ error: 'Could not load a sample bid: ' + (err.message || err) });
  }
  if (!bundle || !bundle.estimate) {
    return res.status(500).json({ error: 'Could not load a sample bid.' });
  }

  // Prefix the project name so the email is obviously a test at a glance and
  // nobody mistakes it for a real win. Does not touch the stored bid.
  const sample = {
    ...bundle,
    estimate: {
      ...bundle.estimate,
      project_name: '[TEST] ' + (bundle.estimate.project_name || 'Sample Project')
    }
  };

  const mode = graphConfigured() ? 'graph' : 'smtp';
  let result;
  try {
    result = await sendWonNotification(sample, [{ email: to, name: (req.user && req.user.name) || '' }]);
  } catch (err) {
    return res.status(502).json({ ok: false, to, mode, error: err.message || String(err) });
  }
  if (result && result.ok && !result.skipped) {
    return res.json({ ok: true, sent: 1, to, mode, sampleBidId: row.id });
  }
  return res.status(502).json({
    ok: false,
    to,
    mode,
    error: (result && (result.error || result.skipped)) || 'unknown send failure'
  });
});

// GET /api/recipients
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT id, email, name, active, created_at
    FROM notification_recipients
    ORDER BY created_at ASC
  `).all();
  res.json({ rows });
});

// POST /api/recipients  { email, name, active }
router.post('/', (req, res) => {
  const { email, name } = req.body || {};
  const e = String(email || '').trim().toLowerCase();
  if (!e || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) {
    return res.status(400).json({ error: 'valid email required' });
  }
  const active = req.body.active === false ? 0 : 1;
  try {
    const info = db.prepare(`
      INSERT INTO notification_recipients (email, name, active)
      VALUES (?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET name = excluded.name, active = excluded.active
    `).run(e, String(name || '').trim(), active);
    const row = db.prepare('SELECT id, email, name, active, created_at FROM notification_recipients WHERE email = ?').get(e);
    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/recipients/:id  { email, name, active }
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const exists = db.prepare('SELECT id FROM notification_recipients WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ error: 'not found' });
  const body = req.body || {};
  const sets = [];
  const vals = [];
  if (body.email != null) {
    const e = String(body.email).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return res.status(400).json({ error: 'invalid email' });
    sets.push('email = ?'); vals.push(e);
  }
  if (body.name != null) { sets.push('name = ?'); vals.push(String(body.name).trim()); }
  if (body.active != null) { sets.push('active = ?'); vals.push(body.active ? 1 : 0); }
  if (sets.length) {
    vals.push(id);
    db.prepare(`UPDATE notification_recipients SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  const row = db.prepare('SELECT id, email, name, active, created_at FROM notification_recipients WHERE id = ?').get(id);
  res.json(row);
});

// DELETE /api/recipients/:id
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const info = db.prepare('DELETE FROM notification_recipients WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ deleted: id });
});

module.exports = router;

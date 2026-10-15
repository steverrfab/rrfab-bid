'use strict';
// The separate test copy of the Bid Tool runs this same code with TEST_COPY=1
// and a SEED_KEY set in its own Railway project. The live app never has either,
// so nothing in this file does anything there.
//
// In the test copy:
//   POST /api/test-copy/seed    a database file to load (X-Integration-Key: SEED_KEY).
//                               Saved as seed.db; the process then restarts and
//                               swaps it in before the database is opened.
//   POST /api/test-copy/invite  { email } -> a set-password link for that user,
//                               since the test copy sends no email.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const isTestCopy = () => process.env.TEST_COPY === '1' && !!process.env.SEED_KEY;
const dataDir = () => process.env.DATA_DIR || path.join(__dirname, '..', 'data');

// Called by db.js before it opens the database.
function swapInSeed() {
  if (!isTestCopy()) return;
  const dir = dataDir();
  const seed = path.join(dir, 'seed.db');
  if (!fs.existsSync(seed)) return;
  for (const f of ['rrbid.db', 'rrbid.db-wal', 'rrbid.db-shm']) {
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* not there */ }
  }
  fs.renameSync(seed, path.join(dir, 'rrbid.db'));
  console.log('[test-copy] loaded seed.db as the test database');
}

function keyOk(req) {
  const got = String(req.headers['x-integration-key'] || '');
  const want = String(process.env.SEED_KEY || '');
  if (!got || !want || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

function router() {
  const express = require('express');
  const r = express.Router();
  r.use((req, res, next) => (isTestCopy() && keyOk(req)) ? next() : res.status(404).end());

  r.post('/seed', express.raw({ type: 'application/octet-stream', limit: '1gb' }), (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 100 || buf.slice(0, 16).toString('latin1') !== 'SQLite format 3\u0000') {
      return res.status(400).json({ error: 'Not a SQLite database file.' });
    }
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(path.join(dataDir(), 'seed.db'), buf);
    console.log('[test-copy] seed.db received (' + buf.length + ' bytes); restarting to load it');
    res.json({ ok: true, bytes: buf.length, note: 'Restarting to load it. Give it a minute.' });
    // Exit with an error code so Railway's on-failure restart brings it back up.
    setTimeout(() => process.exit(1), 500);
  });

  r.post('/invite', (req, res) => {
    const db = require('../db');
    const email = String((req.body && req.body.email) || '').trim();
    const u = db.prepare('SELECT id, name, email FROM users WHERE email = ? COLLATE NOCASE').get(email);
    if (!u) return res.status(404).json({ error: 'No user with that email in the test copy.' });
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 7 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare('INSERT INTO invites (user_id, token, expires_at) VALUES (?, ?, ?)').run(u.id, token, expires);
    const front = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
    res.json({ name: u.name, link: front + '/#/invite/' + token });
  });
  return r;
}

// Test copy only: pull the live database at startup, once per SEED_PULL_ID.
//   SEED_FROM_URL       live backend, e.g. https://rrfab-bid-production.up.railway.app
//   SEED_PULL_KEY       matches TEST_COPY_PULL_KEY on the live backend
//   SEED_PULL_ID        change it to pull fresh live data again
//   SEED_INVITE_EMAIL   after a pull, log a set-password link for this user
// The pulled file is saved as seed.db and the process exits, so the restart
// swaps it in before the database opens (swapInSeed above).
async function startupPull() {
  if (!isTestCopy()) return;
  const from = (process.env.SEED_FROM_URL || '').replace(/\/+$/, '');
  const key = process.env.SEED_PULL_KEY || '';
  if (!from || !key) return;
  const id = process.env.SEED_PULL_ID || 'first';
  const dir = dataDir();
  const marker = path.join(dir, 'seed-pulled.txt');
  const done = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : '';
  if (done === id) { logInvite(id); return; }
  try {
    console.log('[test-copy] pulling live data (pull ' + id + ')');
    const r = await fetch(from + '/api/backup/test-copy-db', { headers: { 'X-Integration-Key': key } });
    if (!r.ok) { console.error('[test-copy] pull refused: HTTP ' + r.status); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.slice(0, 16).toString('latin1') !== 'SQLite format 3\u0000') { console.error('[test-copy] pull returned something that is not a database'); return; }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'seed.db'), buf);
    fs.writeFileSync(marker, id);
    console.log('[test-copy] pulled ' + buf.length + ' bytes; restarting to load it');
    setTimeout(() => process.exit(1), 500);
  } catch (err) {
    console.error('[test-copy] pull failed: ' + err.message);
  }
}

// After a pull is loaded, write one set-password link to the log (the test
// copy sends no email). Once per pull.
function logInvite(id) {
  const email = (process.env.SEED_INVITE_EMAIL || '').trim();
  if (!email) return;
  const flag = path.join(dataDir(), 'seed-invite.txt');
  if (fs.existsSync(flag) && fs.readFileSync(flag, 'utf8').trim() === id) return;
  const db = require('../db');
  const u = db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(email);
  if (!u) { console.error('[test-copy] no user ' + email + ' to make a set-password link for'); return; }
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 7 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('INSERT INTO invites (user_id, token, expires_at) VALUES (?, ?, ?)').run(u.id, token, expires);
  fs.writeFileSync(flag, id);
  const front = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
  console.log('[test-copy] set-password link for ' + email + ': ' + front + '/#/invite/' + token);
}

module.exports = { isTestCopy, swapInSeed, router, startupPull };

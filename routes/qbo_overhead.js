'use strict';
// Settings > Company Wage Rates > QuickBooks Overhead. Reference only.
// The whole section is for an admin or the controller: it shows company
// expenses by account. Nothing here changes company rates or any estimate.
const express = require('express');
const db = require('../db');
const { effectiveQbRole } = require('../lib/access');
const oh = require('../lib/qbo_overhead');

const router = express.Router();

function canEdit(req) {
  if (!req.user || !req.user.userId) return false;
  const u = db.prepare('SELECT role, qb_role FROM users WHERE id = ?').get(req.user.userId);
  if (!u) return false;
  return u.role === 'admin' || u.role === 'superadmin' || effectiveQbRole(u) === 'controller';
}

const userOf = req => ({
  userId: req.user.userId,
  name: (db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.userId) || {}).name || req.user.name,
});

const fail = (res, err, fallback) => {
  if (!err.status) console.error('[qbo-overhead]', err.message);
  res.status(err.status || 500).json({ error: err.status ? err.message : fallback });
};

router.use((req, res, next) => {
  if (canEdit(req)) return next();
  if (req.method === 'GET') return res.json({ can_edit: false });
  res.status(403).json({ error: 'Only an admin or the controller can use the QuickBooks overhead check.' });
});

const payload = () => ({ ...oh.view(), can_edit: true });

router.get('/', (req, res) => res.json(payload()));

router.post('/pull', async (req, res) => {
  const b = req.body || {};
  try { await oh.pull({ start: b.start, end: b.end, user: userOf(req) }); }
  catch (err) { return fail(res, err, 'Could not pull from QuickBooks.'); }
  res.json(payload());
});

router.put('/accounts', (req, res) => {
  const map = req.body && req.body.included;
  if (!map || typeof map !== 'object') return res.status(400).json({ error: 'Send included as { accountId: true/false }.' });
  oh.saveTicks(map);
  res.json(payload());
});

router.put('/snapshots/:id', (req, res) => {
  try { oh.updateSnapshot(+req.params.id, req.body || {}); }
  catch (err) { return fail(res, err, 'Could not save.'); }
  res.json(payload());
});

router.put('/override', (req, res) => {
  const b = req.body || {};
  try { oh.setOverride(b.per_hour, b.note, userOf(req)); }
  catch (err) { return fail(res, err, 'Could not save the override.'); }
  res.json(payload());
});

module.exports = router;

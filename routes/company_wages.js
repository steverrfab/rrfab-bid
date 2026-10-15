'use strict';
// Settings > Company Wage Rates.
// Anyone signed in can read them (estimators see them on the Wage Rates tab).
// Only an admin or a QuickBooks controller can change them. A save never touches
// an existing estimate; it only changes what new estimates start with.
const express = require('express');
const db = require('../db');
const { effectiveQbRole } = require('../lib/access');
const cw = require('../lib/company_wages');

const router = express.Router();

function canEdit(req) {
  if (!req.user || !req.user.userId) return false;
  const u = db.prepare('SELECT role, qb_role FROM users WHERE id = ?').get(req.user.userId);
  if (!u) return false;
  return u.role === 'admin' || u.role === 'superadmin' || effectiveQbRole(u) === 'controller';
}

function payload(req) {
  return { current: cw.latestVersion(), history: cw.listVersions(), can_edit: canEdit(req) };
}

router.get('/', (req, res) => {
  res.json(payload(req));
});

router.put('/', (req, res) => {
  if (!canEdit(req)) {
    return res.status(403).json({ error: 'Only an admin or the controller can change company wage rates.' });
  }
  const rows = req.body && req.body.rows;
  if (!rows || typeof rows !== 'object') return res.status(400).json({ error: 'Send the rates as rows by role.' });
  const name = (db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.userId) || {}).name || req.user.name;
  cw.saveVersion(rows, { userId: req.user.userId, name });
  res.json(payload(req));
});

module.exports = router;

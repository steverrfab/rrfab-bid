'use strict';
// Settings > Company Wage Rates.
// Anyone signed in can read the rates (estimators see them on the Wage Rates tab).
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

// The rate drivers include pay by group, so office pay. Only the people who
// can change the rates see them; everyone else gets the rates alone.
function payload(req) {
  const edit = canEdit(req);
  const current = cw.latestVersion();
  if (current && !edit) delete current.drivers;
  return { current, history: cw.listVersions(), can_edit: edit };
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
  try {
    cw.saveVersion(rows, { userId: req.user.userId, name }, req.body.drivers);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not save company wage rates.' });
  }
  res.json(payload(req));
});

module.exports = router;

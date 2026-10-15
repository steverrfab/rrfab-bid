'use strict';
// Settings > Company Wage Rates > Fingercheck.
// Anyone signed in can see the shop / field / office averages.
// Only an admin or the controller can pull from Fingercheck, see each
// employee's pay, or set which group someone is in.
// Nothing here changes company rates or any estimate.
const express = require('express');
const db = require('../db');
const { effectiveQbRole } = require('../lib/access');
const fc = require('../lib/fingercheck');

const router = express.Router();

function canEdit(req) {
  if (!req.user || !req.user.userId) return false;
  const u = db.prepare('SELECT role, qb_role FROM users WHERE id = ?').get(req.user.userId);
  if (!u) return false;
  return u.role === 'admin' || u.role === 'superadmin' || effectiveQbRole(u) === 'controller';
}

const payload = req => { const edit = canEdit(req); return { ...fc.view(edit), can_edit: edit }; };

router.get('/', (req, res) => res.json(payload(req)));

router.post('/refresh', async (req, res) => {
  if (!canEdit(req)) return res.status(403).json({ error: 'Only an admin or the controller can pull from Fingercheck.' });
  const name = (db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.userId) || {}).name || req.user.name;
  try {
    await fc.refresh({ userId: req.user.userId, name });
  } catch (err) {
    console.error('[fingercheck] refresh failed:', err.message);
    return res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not pull from Fingercheck.' });
  }
  res.json(payload(req));
});

router.put('/groups', (req, res) => {
  if (!canEdit(req)) return res.status(403).json({ error: 'Only an admin or the controller can change employee groups.' });
  const groups = req.body && req.body.groups;
  if (!groups || typeof groups !== 'object') return res.status(400).json({ error: 'Send groups as { employeeNumber: group }.' });
  fc.saveGroups(groups);
  res.json(payload(req));
});

// One person's paychecks: dates, pay periods and hours only. For checking the hours.
router.get('/checks/:employeeNumber', async (req, res) => {
  if (!canEdit(req)) return res.status(403).json({ error: 'Only an admin or the controller can see paychecks.' });
  try { res.json({ checks: await fc.checkList(String(req.params.employeeNumber).slice(0, 40)) }); }
  catch (err) { res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not read paychecks.' }); }
});

module.exports = router;

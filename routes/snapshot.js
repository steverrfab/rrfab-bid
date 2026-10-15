'use strict';
// GET /api/settings/snapshot
// A complete copy of the database, for a superadmin only. Used to load the
// separate test copy of the Bid Tool with today's data. Same safe method as
// the off-site backup (VACUUM INTO), so it never catches a half-written file.
// Reads only: nothing in the live database changes.
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');

const router = express.Router();

// Writes a complete, consistent copy of the database to the response.
function sendSnapshot(res, who) {
  const tmp = path.join(os.tmpdir(), 'rrbid-snapshot-' + crypto.randomBytes(6).toString('hex') + '.db');
  const cleanup = () => { try { fs.unlinkSync(tmp); } catch { /* gone */ } };
  try {
    db.prepare('VACUUM INTO ?').run(tmp);
  } catch (err) {
    cleanup();
    console.error('[snapshot] failed:', err.message);
    return res.status(500).json({ error: 'Could not take a snapshot.' });
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', fs.statSync(tmp).size);
  const stream = fs.createReadStream(tmp);
  stream.once('close', cleanup);
  res.once('close', () => stream.destroy());
  stream.pipe(res);
  console.log('[snapshot] served to ' + who);
}

router.get('/', (req, res) => {
  if (!req.user || req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Only a superadmin can download a copy of the database.' });
  }
  sendSnapshot(res, 'user ' + req.user.userId);
});

module.exports = router;
module.exports.sendSnapshot = sendSnapshot;

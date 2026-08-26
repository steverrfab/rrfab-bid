'use strict';
// Off-site backup of the bid database.
//
// Everything this company has estimated lives in one SQLite file on one Railway
// volume. The Railway plan in use allows no volume backups at all, so without
// this endpoint there is no second copy of that file anywhere. This hands a
// consistent snapshot of it to a caller holding the backup secret, so a job
// somewhere else can pull it on a schedule and keep dated copies.
//
// SECURITY. This returns the entire database, users and password hashes
// included. It is therefore:
//   - guarded by its own shared secret, BACKUP_KEY, sent as X-Integration-Key,
//     the same pattern the Project Tracker feeds already use;
//   - refused outright when BACKUP_KEY is unset, so an un-configured deploy is
//     closed rather than open;
//   - compared with a timing-safe equality check, since a plain !== leaks the
//     secret a character at a time to anyone willing to measure;
//   - read-only. It takes no parameters at all, so there is nothing to inject
//     and no path for a caller to name.
// Set BACKUP_KEY to a long random value in the Railway variables. Treat it as
// being exactly as sensitive as the database itself, because it is.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const router = express.Router();
const db = require('../db');

// The per-request cleanup below handles a finished download and an abandoned
// one alike. What it cannot handle is the process being killed mid-snapshot,
// which on Railway happens on every redeploy. Sweep anything left behind by a
// previous life at startup so stale snapshots can never accumulate.
(function sweepStaleSnapshots() {
  try {
    const dir = os.tmpdir();
    let removed = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith('rrbid-backup-')) continue;
      try { fs.unlinkSync(path.join(dir, f)); removed++; } catch { /* in use, leave it */ }
    }
    if (removed) console.log('[backup] swept ' + removed + ' stale snapshot(s) from a previous run');
  } catch (err) {
    console.error('[backup] stale snapshot sweep skipped:', err.message);
  }
})();

function keyOk(req) {
  const expected = process.env.BACKUP_KEY || '';
  const provided = req.get('X-Integration-Key') || '';
  if (!expected || !provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  // timingSafeEqual throws on a length mismatch, so compare lengths first and
  // still run the comparison, to keep the timing flat either way.
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

// ---- GET /api/backup/db ----
// A consistent point-in-time copy of the whole database.
//
// The live file cannot simply be streamed off disk: the database runs in WAL
// mode, so at any instant the newest commits are in rrbid.db-wal and not yet in
// rrbid.db. A copy taken that way can arrive short or torn. VACUUM INTO asks
// SQLite itself to write a complete, already-checkpointed copy to a new file,
// which is safe to do while the app keeps serving. The copy is also compacted,
// so it is smaller than the original.
router.get('/db', (req, res) => {
  if (!keyOk(req)) return res.status(401).json({ error: 'invalid integration key' });

  // Written to the OS temp dir rather than the data volume so a backup can
  // never eat the space the live database needs.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tmp = path.join(os.tmpdir(), 'rrbid-backup-' + crypto.randomBytes(6).toString('hex') + '.db');

  const cleanup = () => { try { fs.unlinkSync(tmp); } catch { /* already gone */ } };

  try {
    db.prepare('VACUUM INTO ?').run(tmp);
  } catch (err) {
    cleanup();
    console.error('[backup] snapshot failed:', err.message);
    return res.status(500).json({ error: 'could not take a snapshot' });
  }

  const size = fs.statSync(tmp).size;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', size);
  res.setHeader('Content-Disposition', 'attachment; filename="rrbid-' + stamp + '.db"');

  const stream = fs.createReadStream(tmp);
  stream.on('error', (err) => {
    console.error('[backup] stream failed:', err.message);
    cleanup();
    res.destroy();
  });
  // Fires on success and on a dropped connection alike, so the temp file is
  // never left behind.
  res.on('close', cleanup);
  stream.pipe(res);
  console.log('[backup] snapshot served: ' + size + ' bytes');
});

// ---- GET /api/backup/status ----
// Enough to prove the endpoint is reachable and the key is right, without
// moving the database. Useful for checking a scheduled job is still wired up.
router.get('/status', (req, res) => {
  if (!keyOk(req)) return res.status(401).json({ error: 'invalid integration key' });
  const counts = {};
  for (const t of ['estimates', 'change_orders', 'users']) {
    try {
      counts[t] = db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n;
    } catch {
      counts[t] = null;
    }
  }
  // The automatic off-site push reports itself here, so "is it actually still
  // backing up?" is a question with an answer rather than an assumption.
  res.json({
    ok: true,
    counts,
    offsite: require('../lib/offsite_backup').state,
    time: new Date().toISOString()
  });
});

module.exports = router;

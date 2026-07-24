'use strict';
// One-time admin cleanup for the stale proposal_date fix.
//
// Background: cloneEstimateRow used to copy the original proposal_date onto a
// new revision. Because proposal_date is only auto-stamped when empty, those
// revisions kept the stale original date. The code fix stops this going forward;
// this script resets the date on Draft revisions that were already created with
// a stale one, so they get a fresh date on their next submit/download.
//
// Targets exactly: status='Draft' AND revised_from_id IS NOT NULL
//                  AND proposal_date IS NOT NULL
// (Draft revisions only — submitted bids and originals are untouched.)
//
// Usage (run inside the service container, e.g. via `railway ssh`):
//   node scripts/cleanup-stale-proposal-date.js            # dry-run, no changes
//   node scripts/cleanup-stale-proposal-date.js --confirm  # perform the UPDATE
//
// Prints before/after counts in both modes so the output is self-explanatory.
// Safe to delete from the repo once the cleanup has been run in production.

const path = require('path');
const Database = require('better-sqlite3');

// Same DB location pattern as db.js. db.js lives at the repo root and defaults
// DATA_DIR to <root>/data; this script sits one level down in scripts/, so the
// fallback resolves to the same <root>/data. In production DATA_DIR is set and
// takes precedence, pointing at the mounted volume.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'rrbid.db');

const WHERE = "status = 'Draft' AND revised_from_id IS NOT NULL";
const STALE_WHERE = WHERE + ' AND proposal_date IS NOT NULL';

const confirm = process.argv.includes('--confirm');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const countStale = () =>
  db.prepare('SELECT COUNT(*) AS n FROM estimates WHERE ' + STALE_WHERE).get().n;

const before = countStale();
console.log('DB path:            ' + DB_PATH);
console.log('Mode:               ' + (confirm ? 'CONFIRM (will update)' : 'DRY-RUN (no changes)'));
console.log('Stale rows before:  ' + before);

if (!confirm) {
  console.log('Rows changed:       0 (dry-run)');
  console.log('Stale rows after:   ' + before);
  console.log('\nNo changes made. Re-run with --confirm to apply the UPDATE.');
  db.close();
  process.exit(0);
}

const result = db
  .prepare('UPDATE estimates SET proposal_date = NULL WHERE ' + WHERE)
  .run();

const after = countStale();
console.log('Rows changed:       ' + result.changes);
console.log('Stale rows after:   ' + after);
console.log(after === 0 ? '\nCleanup complete.' : '\nWARNING: some stale rows remain — investigate.');

db.close();

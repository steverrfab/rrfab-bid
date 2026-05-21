'use strict';
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const DB_PATH = path.join(DATA_DIR, 'rrbid.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Migration runner. Runs every startup; statements must be idempotent.
// We split each .sql file into individual statements so we can ignore expected
// "duplicate column name" errors when ALTER TABLE ADD COLUMN runs a second time.
function runMigrations() {
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    let sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    // Strip line comments before splitting so a leading "-- ..." doesn't make
    // an entire CREATE TABLE statement look like a pure comment.
    sql = sql.replace(/--[^\n]*/g, '');
    const statements = sql
      .split(/;\s*(?=\n|$)/)
      .map(s => s.trim())
      .filter(s => s.length > 0);
    for (const stmt of statements) {
      try {
        db.exec(stmt);
      } catch (err) {
        const msg = err.message || '';
        if (/duplicate column name/i.test(msg)) {
          // Column already added on a prior run; safe to skip.
          continue;
        }
        throw err;
      }
    }
    console.log(`[db] migration applied: ${f}`);
  }
}

function seedAisc() {
  const count = db.prepare('SELECT COUNT(*) as n FROM aisc_sections').get().n;
  if (count > 0) {
    console.log(`[db] aisc already seeded (${count} rows)`);
    return;
  }
  const seedPath = path.join(__dirname, 'seed', 'aisc.json');
  const data = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const insert = db.prepare('INSERT OR IGNORE INTO aisc_sections (label, t_f, weight_per_ft) VALUES (?, ?, ?)');
  const tx = db.transaction((rows) => {
    for (const r of rows) insert.run(r.label, r.t_f || '', r.weight_per_ft);
  });
  tx(data);
  console.log(`[db] aisc seeded: ${data.length} rows`);
}

runMigrations();
seedAisc();

module.exports = db;

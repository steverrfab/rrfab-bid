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

function runMigrations() {
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    db.exec(sql);
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

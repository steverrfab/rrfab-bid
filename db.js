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
    // Strip line comments before splitting so a leading "-- ..." does not make
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
    console.log('[db] migration applied: ' + f);
  }
}

function seedAisc() {
  const count = db.prepare('SELECT COUNT(*) as n FROM aisc_sections').get().n;
  if (count > 0) {
    console.log('[db] aisc already seeded (' + count + ' rows)');
    return;
  }
  const seedPath = path.join(__dirname, 'seed', 'aisc.json');
  const data = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const insert = db.prepare('INSERT OR IGNORE INTO aisc_sections (label, t_f, weight_per_ft) VALUES (?, ?, ?)');
  const tx = db.transaction((rows) => {
    for (const r of rows) insert.run(r.label, r.t_f || '', r.weight_per_ft);
  });
  tx(data);
  console.log('[db] aisc seeded: ' + data.length + ' rows');
}

// Runs once on first deploy when the users table is empty.
// Creates the first admin account and prints a setup link to the logs.
function seedFirstAdmin() {
  try {
    const count = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
    if (count > 0) return;

    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const frontendUrl = process.env.FRONTEND_URL || 'https://bid.rrfabrication.org';

    db.prepare("INSERT INTO users (email, name, role, active) VALUES (?, ?, 'admin', 0)")
      .run('stevem@rrfabrication.org', 'Steve');
    const userId = db.prepare('SELECT last_insert_rowid() as id').get().id;
    db.prepare('INSERT INTO invites (user_id, token, expires_at) VALUES (?, ?, ?)')
      .run(userId, token, expires);

    console.log('');
    console.log('='.repeat(60));
    console.log('[SETUP] First admin account created: stevem@rrfabrication.org');
    console.log('[SETUP] Set your password (link valid 7 days):');
    console.log('[SETUP] ' + frontendUrl + '/#/invite/' + token);
    console.log('='.repeat(60));
    console.log('');
  } catch (err) {
    // users table may not exist yet if migrations have not run; safe to skip
    if (!/no such table/i.test(err.message)) throw err;
  }
}

const STANDARD_EXCLUSIONS = [
  'Field verification of existing conditions',
  'Fireproofing/intumescent coatings',
  'Special inspections',
  'Concrete/grout or dry pack',
  'Permits/bonds/jobsite parking',
  'Bolts or fasteners for other trades',
  'Demolition of any kind',
  'Temp. shoring or bracing',
  'Galvanized material (UNO)/PRIMING OF GALVANIZED STEEL',
  'Light gauge material',
  'Paint other than shop primer',
  'Testing or inspections',
  'Steel prep. other than SP-2 or SP-3',
  'Engineer stamp on shop drawings (UNO)',
  'Setting or layout of anchor bolts/leveling plates/embed items',
  'Roof or floor openings not shown or penetrations',
  'Patching of existing roof area',
  'Metal Deck on Light Gauge Framing',
  'Wood connection bolts or steel plates',
  'Unistrut material (furnish or install)',
  'CMU Wall Supports (UNO)',
  'Roof Frames not shown on Structural Drawings',
  'Any item not listed in scope',
  'Liquid applied thermo break materials'
];

function seedStandardExclusions() {
  try {
    const count = db.prepare('SELECT COUNT(*) as n FROM standard_exclusions').get().n;
    if (count > 0) return;
    const insert = db.prepare('INSERT INTO standard_exclusions (text, position, active) VALUES (?, ?, 1)');
    const tx = db.transaction((items) => {
      items.forEach((text, i) => insert.run(text, i + 1));
    });
    tx(STANDARD_EXCLUSIONS);
    console.log('[db] standard exclusions seeded: ' + STANDARD_EXCLUSIONS.length + ' rows');
  } catch (err) {
    if (!/no such table/i.test(err.message)) throw err;
  }
}

runMigrations();
seedAisc();
seedFirstAdmin();
seedStandardExclusions();

module.exports = db;

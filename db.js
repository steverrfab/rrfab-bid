'use strict';
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { normalizeLabel } = require('./lib/sections');

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
  // Idempotent top-up. seed/aisc.json is the source of truth for WHICH sections
  // exist; INSERT OR IGNORE adds any that are missing and never overwrites an
  // existing row (so weights already in the table are left alone and saved bids
  // are unaffected). Running every startup keeps a fresh install complete even
  // though earlier migrations may have inserted a few rows first, and lets a
  // seed expansion reach an already-populated database. Weight CORRECTIONS to
  // existing rows are done separately via UPDATE migrations, since INSERT OR
  // IGNORE cannot change an existing weight.
  const seedPath = path.join(__dirname, 'seed', 'aisc.json');
  const data = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const before = db.prepare('SELECT COUNT(*) as n FROM aisc_sections').get().n;
  const insert = db.prepare('INSERT OR IGNORE INTO aisc_sections (label, t_f, weight_per_ft) VALUES (?, ?, ?)');
  const tx = db.transaction((rows) => {
    for (const r of rows) insert.run(r.label, r.t_f || '', r.weight_per_ft);
  });
  tx(data);
  const after = db.prepare('SELECT COUNT(*) as n FROM aisc_sections').get().n;
  console.log('[db] aisc seed top-up: ' + (after - before) + ' added, ' + after + ' total');
}

// Recompute the normalized-label column for every section on each startup, so
// label_norm always reflects the current normalizeLabel() rules and any labels
// added by seed or migrations. Cheap (a few hundred rows) and idempotent. Only
// writes rows whose normalized value actually changed. Guarded so it is a no-op
// if migration 044 has not added the column yet.
function normalizeSections() {
  try {
    const cols = db.prepare('PRAGMA table_info(aisc_sections)').all();
    if (!cols.some(c => c.name === 'label_norm')) return;
    const rows = db.prepare('SELECT label, label_norm FROM aisc_sections').all();
    const upd = db.prepare('UPDATE aisc_sections SET label_norm = ? WHERE label = ?');
    let changed = 0;
    const tx = db.transaction(() => {
      for (const r of rows) {
        const norm = normalizeLabel(r.label);
        if (r.label_norm !== norm) { upd.run(norm, r.label); changed++; }
      }
    });
    tx();
    if (changed) console.log('[db] aisc label_norm updated: ' + changed + ' rows');
  } catch (err) {
    console.error('[db] label_norm population skipped:', err.message);
  }
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

// One-time backfill: before status traveled across a job family, a revision
// could be left behind when its job was marked Won/Lost. Sync each family that
// contains a Won (or Lost) version so every version matches. Guarded by a marker
// so it runs once, never fighting normal operation on later restarts.
function reconcileWonLostFamilies() {
  try {
    db.exec("CREATE TABLE IF NOT EXISTS _data_fixes (name TEXT PRIMARY KEY, applied_at TEXT)");
    const done = db.prepare('SELECT 1 FROM _data_fixes WHERE name = ?').get('042_family_won_lost_sync');
    if (done) return;
    const rows = db.prepare("SELECT id, bid_number, status FROM estimates WHERE deleted_at IS NULL AND is_alternate = 0 AND bid_number IS NOT NULL AND bid_number != ''").all();
    const fams = new Map();
    for (const r of rows) {
      const base = String(r.bid_number).split('.')[0];
      if (!fams.has(base)) fams.set(base, []);
      fams.get(base).push(r);
    }
    const updWon = db.prepare("UPDATE estimates SET status = 'Won', won_at = COALESCE(won_at, datetime('now')), updated_at = datetime('now') WHERE id = ?");
    const updLost = db.prepare("UPDATE estimates SET status = 'Lost', updated_at = datetime('now') WHERE id = ?");
    let changed = 0;
    const tx = db.transaction(() => {
      for (const [base, members] of fams) {
        if (members.length < 2) continue;
        const target = members.some(m => m.status === 'Won') ? 'Won'
                     : (members.some(m => m.status === 'Lost') ? 'Lost' : null);
        if (!target) continue;
        for (const m of members) {
          if (m.status !== target) { (target === 'Won' ? updWon : updLost).run(m.id); changed++; }
        }
      }
      db.prepare("INSERT OR IGNORE INTO _data_fixes (name, applied_at) VALUES (?, datetime('now'))").run('042_family_won_lost_sync');
    });
    tx();
    if (changed) console.log('[db] family won/lost status sync: updated ' + changed + ' bid(s)');
  } catch (err) {
    console.error('[db] family status sync skipped:', err.message);
  }
}

// One-time: undo the plate weight pinning below.
//
// The pinning existed to protect already-quoted bids from a change to
// plateUnitWeight. That change has since been reverted, and the fix moved to
// the import path instead, so old rows compute exactly as they always did and
// there is nothing left to protect them from. The stored weights are no longer
// doing any work, and they were written to bids that should not have been
// touched, so they come back out.
//
// Only rows the pinning itself wrote are cleared: a row qualifies only if its
// stored weight is exactly the number that routine would have produced from its
// own dimensions. A genuine weight from an estimator's workbook comes off
// column J with their waste already in it and cannot equal that, so imported
// weights are left alone.
//
// Skipped entirely on any database where the pinning never ran.
function unpinLegacyPlateWeights() {
  try {
    db.exec("CREATE TABLE IF NOT EXISTS _data_fixes (name TEXT PRIMARY KEY, applied_at TEXT)");
    const MARKER = '057_unpin_legacy_plate_weights';
    if (db.prepare('SELECT 1 FROM _data_fixes WHERE name = ?').get(MARKER)) return;
    const pinned = db.prepare('SELECT 1 FROM _data_fixes WHERE name = ?').get('056_freeze_legacy_plate_weights');
    if (!pinned) {
      db.prepare("INSERT OR IGNORE INTO _data_fixes (name, applied_at) VALUES (?, datetime('now'))").run(MARKER);
      return;
    }

    const { legacyPlateUnitWeight } = require('./lib/calc');
    const rows = db.prepare(
      'SELECT id, thickness, width_in, length_in, qty, weight_lb FROM takeoff_plates WHERE weight_lb IS NOT NULL AND weight_lb > 0'
    ).all();
    const upd = db.prepare('UPDATE takeoff_plates SET weight_lb = 0 WHERE id = ?');
    let cleared = 0;
    const tx = db.transaction(() => {
      for (const r of rows) {
        const sqft = ((+r.width_in || 0) * (+r.length_in || 0) * (+r.qty || 0)) / 144;
        const pinnedWeight = sqft * legacyPlateUnitWeight(r.thickness);
        // Same arithmetic, same order, so a pinned row matches bit for bit.
        if (pinnedWeight > 0 && Math.abs(+r.weight_lb - pinnedWeight) < 1e-9) {
          upd.run(r.id);
          cleared += 1;
        }
      }
      db.prepare("INSERT OR IGNORE INTO _data_fixes (name, applied_at) VALUES (?, datetime('now'))").run(MARKER);
    });
    tx();
    console.log('[db] plate weight unpin: cleared ' + cleared + ' row(s) back to where they were');
  } catch (err) {
    console.error('[db] plate weight unpin skipped:', err.message);
  }
}

// SUPERSEDED by unpinLegacyPlateWeights above. Kept only so the marker logic
// reads honestly on databases where it already ran. It is no longer called.
//
// One-time: freeze every plate row that already exists at the weight it was
// quoted at, so no bid that has already gone out to a GC moves.
//
// Plate thicknesses were stored with the inch mark ('3/8"'), which the weight
// lookup misread as three INCHES thick instead of three eighths -- eight times
// heavy. Fixing that lookup was necessary for new work, but it also silently
// reweighed every bid already in the system, including ones that had been sent.
//
// takeoff_plates.weight_lb means "this is the weight that was quoted, use it as
// it stands". Writing each existing row's OLD computed weight into that column
// pins those bids to the exact numbers they were sent with, while anything
// imported from here on uses the corrected weights.
//
// This is not a blessing of the old numbers. It is a record of what went out.
// Editing a row's thickness, width, length or qty clears weight_lb and hands
// that row back to the corrected calculation, so a bid can be brought up to
// date deliberately, one row at a time, rather than all at once behind your
// back.
//
// Rows that already carry a weight from the estimator are left alone, and the
// marker means this runs exactly once no matter how many times the app restarts.
function freezeLegacyPlateWeights() {
  try {
    db.exec("CREATE TABLE IF NOT EXISTS _data_fixes (name TEXT PRIMARY KEY, applied_at TEXT)");
    const MARKER = '056_freeze_legacy_plate_weights';
    if (db.prepare('SELECT 1 FROM _data_fixes WHERE name = ?').get(MARKER)) return;

    const { legacyPlateUnitWeight } = require('./lib/calc');
    // weight_lb was added with DEFAULT 0, so "no quoted weight" is stored as 0
    // on every row that predates this, not as NULL. calc treats both the same
    // way (fall through to the dimensions), so both have to be pinned.
    const rows = db.prepare(
      'SELECT id, thickness, width_in, length_in, qty FROM takeoff_plates WHERE weight_lb IS NULL OR weight_lb = 0'
    ).all();
    const upd = db.prepare('UPDATE takeoff_plates SET weight_lb = ? WHERE id = ?');
    let frozen = 0;
    const tx = db.transaction(() => {
      for (const r of rows) {
        const sqft = ((+r.width_in || 0) * (+r.length_in || 0) * (+r.qty || 0)) / 144;
        const weight = sqft * legacyPlateUnitWeight(r.thickness);
        // A row that weighed nothing before has nothing to preserve, and pinning
        // it at 0 would stop it ever calculating.
        if (weight > 0) { upd.run(weight, r.id); frozen += 1; }
      }
      db.prepare("INSERT OR IGNORE INTO _data_fixes (name, applied_at) VALUES (?, datetime('now'))").run(MARKER);
    });
    tx();
    console.log('[db] plate weight freeze: pinned ' + frozen + ' existing plate row(s) at their quoted weight');
  } catch (err) {
    console.error('[db] plate weight freeze skipped:', err.message);
  }
}

// Migration 056, second half. A change order no longer has to be attached to a
// bid, so change_orders.estimate_id must be nullable. SQLite has no
// "ALTER COLUMN DROP NOT NULL", so the table has to be rebuilt. This lives here
// rather than in the .sql file because db.js re-runs every migration on every
// startup and a rebuild written in SQL would therefore rebuild the table on
// every deploy. Guarded on the real schema: once estimate_id is nullable this
// is a no-op forever, no marker table needed.
function relaxChangeOrderParent() {
  try {
    const cols = db.prepare('PRAGMA table_info(change_orders)').all();
    if (!cols.length) return;                      // table not created yet
    const parent = cols.find(c => c.name === 'estimate_id');
    if (!parent || parent.notnull === 0) return;   // already nullable, nothing to do

    // Copy by name so this survives any future column added ahead of the rebuild.
    const names = cols.map(c => c.name);
    const cols_sql = names.map(n => '"' + n + '"').join(', ');

    // Keep a verbatim copy of the table as it stood before the rebuild. The
    // Railway plan this runs on allows no volume backups at all, so this is the
    // only safety net there is: if the rebuild ever goes wrong, every original
    // row is still sitting in change_orders_pre056 to be read back by hand.
    // Costs nothing to leave in place — the table is small — and it is created
    // only on the one startup that actually rebuilds.
    db.exec('DROP TABLE IF EXISTS change_orders_pre056');
    db.exec('CREATE TABLE change_orders_pre056 AS SELECT * FROM change_orders');
    const saved = db.prepare('SELECT COUNT(*) AS n FROM change_orders_pre056').get().n;
    const live = db.prepare('SELECT COUNT(*) AS n FROM change_orders').get().n;
    if (saved !== live) throw new Error('pre-056 safety copy is short: ' + saved + ' of ' + live);
    console.log('[db] change_orders_pre056 safety copy written: ' + saved + ' row(s)');

    // foreign_keys must be toggled OUTSIDE a transaction; SQLite ignores the
    // pragma inside one. change_order_lines points at change_orders, so the
    // drop-and-rename needs enforcement off for the moment it is in flight.
    db.exec('PRAGMA foreign_keys = OFF');
    const tx = db.transaction(() => {
      db.exec(`CREATE TABLE change_orders_rebuild (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        estimate_id INTEGER REFERENCES estimates(id),
        parent_type TEXT NOT NULL DEFAULT 'standalone',
        project_name TEXT NOT NULL DEFAULT '',
        client_gc TEXT NOT NULL DEFAULT '',
        seq INTEGER NOT NULL DEFAULT 1,
        title TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        requested_by TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL DEFAULT '',
        pricing_mode TEXT NOT NULL DEFAULT 'quick',
        status TEXT NOT NULL DEFAULT 'Draft',
        oh_rate REAL DEFAULT 0.05,
        contingency_rate REAL DEFAULT 0,
        profit_rate REAL DEFAULT 0.10,
        cgl_rate REAL DEFAULT 0,
        sales_tax_rate REAL DEFAULT 0.06,
        tax_mode TEXT DEFAULT 'full',
        created_by INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        deleted_at TEXT
      )`);
      db.exec('INSERT INTO change_orders_rebuild (' + cols_sql + ') SELECT ' + cols_sql + ' FROM change_orders');
      db.exec('DROP TABLE change_orders');
      db.exec('ALTER TABLE change_orders_rebuild RENAME TO change_orders');
      db.exec('CREATE INDEX IF NOT EXISTS idx_change_orders_estimate ON change_orders(estimate_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_change_orders_status ON change_orders(status)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_change_orders_standalone ON change_orders(seq) WHERE estimate_id IS NULL');
    });
    tx();
    db.exec('PRAGMA foreign_keys = ON');
    const n = db.prepare('SELECT COUNT(*) AS n FROM change_orders').get().n;
    // Count and, more importantly, the identifying fields must match the copy
    // taken a moment ago. A silent short-copy is the failure worth catching.
    const drift = db.prepare(
      `SELECT COUNT(*) AS n FROM change_orders_pre056 p
        WHERE NOT EXISTS (
          SELECT 1 FROM change_orders c
           WHERE c.id = p.id AND c.seq = p.seq
             AND IFNULL(c.estimate_id, -1) = IFNULL(p.estimate_id, -1)
             AND c.title = p.title AND c.status = p.status
             AND IFNULL(c.profit_rate, -1) = IFNULL(p.profit_rate, -1))`
    ).get().n;
    if (n !== saved || drift > 0) {
      console.error('[db] WARNING: change_orders rebuild does not match the pre-056 copy'
        + ' (' + n + ' vs ' + saved + ' rows, ' + drift + ' row(s) changed).'
        + ' The originals are intact in change_orders_pre056.');
    } else {
      console.log('[db] change_orders.estimate_id relaxed to nullable; '
        + n + ' row(s) preserved, verified against change_orders_pre056');
    }
  } catch (err) {
    db.exec('PRAGMA foreign_keys = ON');
    console.error('[db] change_orders parent relax skipped:', err.message);
  }
}

runMigrations();
seedAisc();
normalizeSections();
seedFirstAdmin();
seedStandardExclusions();
reconcileWonLostFamilies();
unpinLegacyPlateWeights();
relaxChangeOrderParent();

module.exports = db;

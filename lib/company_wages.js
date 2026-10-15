'use strict';
// Company wage rates: the burden rates kept in Settings and copied into every
// new estimate. Each save is a new row in company_wage_versions; the newest one
// is the current set. Estimates keep their own copy in wage_rates, so changing
// company rates never changes an estimate that already exists.

const db = require('../db');

// The five roles kept in Settings. Each has a half role on the estimate, built
// from it when copied.
const FULL_ROLES = ['shop_worker', 'ironworker', 'firewatch', 'laborer', 'pm'];
const HALF_OF = {
  shop_half: 'shop_worker',
  ironworker_half: 'ironworker',
  firewatch_half: 'firewatch',
  laborer_half: 'laborer',
  pm_half: 'pm'
};

// Numeric fields. null means "Not set": counted as 0 in the math, but shown as
// missing so it is never mistaken for a real zero.
const NUM_FIELDS = [
  'base_rate', 'cash_in_lieu', 'fica_pct', 'futa_pct', 'suta_pct',
  'wc_pct', 'wc_base_pct', 'wc_mod', 'gl_pct', 'umbrella_pct', 'auto_pct',
  'pp_bond_pct', 'health_welfare', 'pension', 'consumables_pct', 'fuel_pct', 'ohp_pct'
];
const TEXT_FIELDS = ['wc_class'];
// Dollar-per-hour fields that are halved for a half role. Percentages are not,
// since they already scale with the halved base rate.
const HALVED = ['base_rate', 'cash_in_lieu', 'health_welfare', 'pension'];

// Blank, null or unreadable -> null (Not set). Anything else -> a number.
function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Effective workers comp. When the policy base rate is entered, it is the base
// rate times the experience mod (1 when the mod is blank). Otherwise the
// combined rate is used as entered, which is how every existing estimate works.
function effectiveWc(row) {
  const base = toNum(row.wc_base_pct);
  if (base == null) return toNum(row.wc_pct);
  const mod = toNum(row.wc_mod);
  return Math.round(base * (mod == null ? 1 : mod) * 1e10) / 1e10;
}

// Clean one role from a request: known fields only, numbers or null.
function cleanRole(src) {
  const out = {};
  for (const f of NUM_FIELDS) out[f] = toNum(src ? src[f] : null);
  for (const f of TEXT_FIELDS) out[f] = src && src[f] != null ? String(src[f]).trim().slice(0, 20) : '';
  out.wc_pct = effectiveWc(out);
  return out;
}

function latestVersion() {
  const v = db.prepare('SELECT * FROM company_wage_versions ORDER BY id DESC LIMIT 1').get();
  return v ? parseVersion(v) : null;
}

function getVersion(id) {
  if (id == null) return null;
  const v = db.prepare('SELECT * FROM company_wage_versions WHERE id = ?').get(id);
  return v ? parseVersion(v) : null;
}

function parseVersion(v) {
  let rows = {};
  try { rows = JSON.parse(v.rows_json) || {}; } catch { rows = {}; }
  const clean = {};
  for (const r of FULL_ROLES) clean[r] = cleanRole(rows[r]);
  let drivers = null;
  try { drivers = v.drivers_json ? cleanDrivers(JSON.parse(v.drivers_json)) : null; } catch { drivers = null; }
  return { id: v.id, saved_at: v.saved_at, saved_by: v.saved_by, saved_by_name: v.saved_by_name, rows: clean, drivers };
}

// Rate drivers are the inputs behind the rates (premiums, head count, monthly
// overhead). They are worked out on the page; here they are only kept, so the
// shape can grow without a migration. Cleaned to plain data of a sane size:
// numbers, short text, true/false and null, nested a few levels at most.
const DRIVERS_MAX_BYTES = 64 * 1024;
function cleanDrivers(v, depth = 0) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.slice(0, 120);
  if (depth >= 5) return null;
  if (Array.isArray(v)) return v.slice(0, 200).map(x => cleanDrivers(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).slice(0, 200)) {
      if (!/^[A-Za-z0-9_]{1,40}$/.test(k)) continue;
      out[k] = cleanDrivers(v[k], depth + 1);
    }
    return out;
  }
  return null;
}

function listVersions(limit = 25) {
  return db.prepare('SELECT id, saved_at, saved_by_name FROM company_wage_versions ORDER BY id DESC LIMIT ?').all(limit);
}

// driversIn: the rate drivers to keep with this version. Left out (undefined),
// the drivers from the current version carry forward so they are never lost.
function saveVersion(rowsIn, user, driversIn) {
  const rows = {};
  for (const r of FULL_ROLES) rows[r] = cleanRole(rowsIn ? rowsIn[r] : null);
  let drivers;
  if (driversIn === undefined) { const cur = latestVersion(); drivers = cur ? cur.drivers : null; }
  else drivers = cleanDrivers(driversIn);
  let driversJson = drivers == null ? null : JSON.stringify(drivers);
  if (driversJson && Buffer.byteLength(driversJson) > DRIVERS_MAX_BYTES) {
    const err = new Error('Rate drivers are too large to save.'); err.status = 400; throw err;
  }
  const info = db.prepare(
    'INSERT INTO company_wage_versions (rows_json, saved_by, saved_by_name, drivers_json) VALUES (?, ?, ?, ?)'
  ).run(JSON.stringify(rows), user && user.userId || null, user && user.name || null, driversJson);
  return getVersion(info.lastInsertRowid);
}

// The ten estimate rows (five full roles plus their halves) for a version.
function estimateRowsFor(version) {
  const out = [];
  for (const role of FULL_ROLES) out.push({ role, ...version.rows[role] });
  for (const [half, full] of Object.entries(HALF_OF)) {
    const r = { role: half, ...version.rows[full] };
    for (const f of HALVED) if (r[f] != null) r[f] = r[f] / 2;
    out.push(r);
  }
  return out;
}

const ALL_COLS = [...NUM_FIELDS, ...TEXT_FIELDS];

// Write a version's rates onto an estimate, replacing whatever wage rows it has.
// Used for a brand-new estimate and for "Reset to company rates" on one estimate.
function applyToEstimate(estimateId, version) {
  const cols = ['estimate_id', 'role', ...ALL_COLS, 'company_version_id'];
  const insert = db.prepare(
    `INSERT INTO wage_rates (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
  );
  db.transaction(() => {
    db.prepare('DELETE FROM wage_rates WHERE estimate_id = ?').run(estimateId);
    for (const r of estimateRowsFor(version)) {
      insert.run(estimateId, r.role, ...ALL_COLS.map(c => r[c]), version.id);
    }
  })();
}

// New estimates: copy the current company rates, if any have been saved.
// Returns true when rates were copied. Before anyone saves company rates the
// estimate is left alone and gets the original built-in defaults, as today.
function seedNewEstimate(estimateId) {
  const v = latestVersion();
  if (!v) return false;
  applyToEstimate(estimateId, v);
  return true;
}

module.exports = {
  FULL_ROLES, HALF_OF, NUM_FIELDS, TEXT_FIELDS, toNum, effectiveWc, cleanRole, cleanDrivers,
  latestVersion, getVersion, listVersions, saveVersion, estimateRowsFor,
  applyToEstimate, seedNewEstimate
};

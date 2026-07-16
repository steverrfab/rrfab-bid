'use strict';
// Resubmit change-capture.
//
// buildSnapshot(db, id) captures a JSON-serializable picture of a bid's priced
// INPUTS: the estimate row plus EVERY table that has an estimate_id column
// (takeoff, cost inputs, hardware, wages, process-only, proposal edits, ...).
// It is stored on submit and refreshed on each resubmit so the next resubmit can
// diff against the prior snapshot. Discovering the child tables dynamically means
// a new estimate-scoped table is picked up automatically — nothing to maintain.
//
// diffSnapshots(before, after) returns a flat array of short, human-readable
// strings describing what changed ("Profit: 10% -> 12%", "Takeoff shapes: added
// W12X26", "Wage rates: Fitter changed (Base Rate: 45 -> 48)").
//
// READ-ONLY with respect to pricing: never writes, output is display/audit only,
// and every function swallows its own errors, so a bug here cannot break a submit
// or a calculation.

// Estimate-row columns that are not user inputs (identity, status, lifecycle,
// bookkeeping) and must not appear as "changes".
const SKIP_EST_COLS = new Set([
  'id', 'bid_number', 'status', 'confirmed', 'submitted_at', 'proposal_date',
  'created_at', 'updated_at', 'deleted_at', 'won_at', 'due_date', 'created_by',
  'revised_from_id', 'bid_type', 'is_alternate', 'parent_estimate_id',
  'alt_label', 'alt_position', 'job_number_assigned_by', 'job_number_assigned_at',
  'submit_snapshot'
]);

// estimate_id-bearing tables that are NOT bid inputs and must be ignored.
const SKIP_TABLES = new Set(['estimate_locks', 'estimate_resubmits']);

// Friendlier labels for common estimate fields; fallback = prettified column.
const EST_LABELS = {
  project_name: 'Project name', job_number: 'Job number', client_gc: 'Client / GC',
  bid_date: 'Bid due date', prepared_by: 'Prepared by', scope: 'Scope',
  drawing_numbers: 'Drawing numbers', notes: 'Internal notes', job_type: 'Job type',
  fab_mh: 'Fab man-hours', fab_rate: 'Fab rate ($/hr)', processing_rate: 'Processing rate ($/lb)',
  paint_weight: 'Paint weight', paint_rate: 'Paint rate ($/lb)',
  consumables_weight: 'Consumables weight', consumables_rate: 'Consumables rate ($/lb)',
  handling_weight: 'Handling weight', handling_rate: 'Handling rate ($/lb)',
  galv_weight: 'Galv weight', galv_rate: 'Galv rate ($/lb)',
  struct_detailing: 'Structural detailing', misc_detailing: 'Misc detailing',
  pe_stamp: 'PE stamp', freight: 'Freight', erection_mh: 'Erection man-hours',
  erection_rate: 'Erection rate ($/hr)', erection_equip: 'Erection equipment',
  oh_rate: 'Overhead', contingency_rate: 'Contingency', profit_rate: 'Profit',
  cgl_rate: 'CGL', sales_tax_rate: 'Sales tax', tax_mode: 'Tax mode',
  price_to_win: 'Price to win', proposal_notes: 'Proposal notes',
  proposal_to: 'Proposal: To', proposal_scope: 'Proposal: Scope',
  proposal_exclusions: 'Proposal: Exclusions', proposal_terms: 'Proposal: Terms',
  proposal_submitted_by: 'Proposal: Submitted by'
};

// Friendlier labels for known child tables; fallback = prettified table name.
const TABLE_LABELS = {
  material_overrides: 'Material overrides', takeoff_shapes: 'Takeoff shapes',
  takeoff_plates: 'Takeoff plates', takeoff_misc: 'Takeoff misc', wage_rates: 'Wage rates',
  estimate_extras: 'Cost input extras', estimate_hardware: 'Hardware',
  hardware_line_items: 'Hardware', process_only_lines: 'Process-only lines',
  process_only_addcosts: 'Process-only add-costs', estimate_site_exclusions: 'Site exclusions',
  proposal_manual_lines: 'Proposal manual lines', proposal_line_visibility: 'Proposal line visibility',
  proposal_client_lines: 'Proposal breakdown'
};

// Candidate identifier fields, tried in order, to name a row in messages.
const KEY_CANDIDATES = ['section_name', 'role', 'section', 'label', 'name', 'description', 'shape', 'thickness', 'text', 'item'];

// Columns stored as decimals that represent true percentages (0.10 -> "10%").
const PERCENT_COLS = new Set([
  'oh_rate', 'contingency_rate', 'profit_rate', 'cgl_rate', 'sales_tax_rate',
  'ljb_op_rate', 'fica_pct', 'futa_pct', 'suta_pct', 'wc_pct', 'gl_pct',
  'umbrella_pct', 'auto_pct', 'pp_bond_pct', 'consumables_pct', 'fuel_pct', 'ohp_pct'
]);

// Long free-text estimate fields: report "changed" rather than dumping text.
const LONG_TEXT_COLS = new Set([
  'scope', 'notes', 'proposal_scope', 'proposal_exclusions', 'proposal_terms',
  'proposal_notes', 'proposal_to', 'drawing_numbers'
]);

// Per-row bookkeeping columns ignored when diffing child rows.
const ROW_SKIP = new Set(['id', 'estimate_id', 'position', 'created_at', 'updated_at']);

function prettify(s) {
  return String(s).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Tables that have an estimate_id column (dynamic discovery). Never throws.
function estimateScopedTables(db) {
  const out = [];
  try {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    for (const t of names) {
      if (SKIP_TABLES.has(t) || /^sqlite_/.test(t)) continue;
      let cols = [];
      try { cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name); }
      catch (e) { continue; }
      if (cols.includes('estimate_id')) out.push(t);
    }
  } catch (e) { /* return whatever we have */ }
  return out;
}

// Rows for one estimate-scoped table, ordered stably. Never throws.
function safeRows(db, table, id) {
  const attempts = [
    `SELECT * FROM ${table} WHERE estimate_id = ? ORDER BY position, id`,
    `SELECT * FROM ${table} WHERE estimate_id = ? ORDER BY id`,
    `SELECT * FROM ${table} WHERE estimate_id = ?`
  ];
  for (const sql of attempts) {
    try { return db.prepare(sql).all(id); } catch (e) { /* try next */ }
  }
  return [];
}

// Build the snapshot. Never throws (returns a partial snapshot on error).
function buildSnapshot(db, id) {
  const snap = { fields: {}, children: {} };
  try {
    const est = db.prepare('SELECT * FROM estimates WHERE id = ?').get(id) || {};
    for (const k of Object.keys(est)) {
      if (!SKIP_EST_COLS.has(k)) snap.fields[k] = est[k];
    }
  } catch (e) { /* leave fields */ }
  for (const t of estimateScopedTables(db)) {
    snap.children[t] = safeRows(db, t, id);
  }
  return snap;
}

// ---- value formatting / comparison ----

function isBlank(v) { return v === null || v === undefined || v === ''; }

function numeric(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !isNaN(+v)) return +v;
  return null;
}

function sameValue(a, b) {
  if (isBlank(a) && isBlank(b)) return true;
  const na = numeric(a), nb = numeric(b);
  if (na !== null && nb !== null) return Math.abs(na - nb) < 1e-6;
  return String(a) === String(b);
}

function fmtValue(col, v) {
  if (isBlank(v)) return '(blank)';
  const n = numeric(v);
  if (n !== null) {
    if (PERCENT_COLS.has(col)) return (Math.round(n * 10000) / 100) + '%';
    return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
  }
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
}

function isLongText(col, a, b) {
  if (LONG_TEXT_COLS.has(col)) return true;
  const la = isBlank(a) ? 0 : String(a).length;
  const lb = isBlank(b) ? 0 : String(b).length;
  return Math.max(la, lb) > 45;
}

// ---- diff ----

function rowKey(table, row, i) {
  if (!row) return `#${i + 1}`;
  // Shapes: the section name (e.g. "W12X26") is the meaningful identifier.
  if (table === 'takeoff_shapes') {
    if (!isBlank(row.section_name)) return String(row.section_name);
    if (!isBlank(row.section_type)) return String(row.section_type);
    return `#${i + 1}`;
  }
  for (const f of KEY_CANDIDATES) {
    if (!isBlank(row[f])) return String(row[f]);
  }
  return `#${i + 1}`;
}

function rowFieldChanges(before, after) {
  const cols = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const out = [];
  for (const col of cols) {
    if (ROW_SKIP.has(col)) continue;
    const b = before ? before[col] : undefined;
    const a = after ? after[col] : undefined;
    if (sameValue(b, a)) continue;
    if (isLongText(col, b, a)) out.push(`${prettify(col)} changed`);
    else out.push(`${prettify(col)}: ${fmtValue(col, b)} -> ${fmtValue(col, a)}`);
    if (out.length >= 4) { out.push('…'); break; }
  }
  return out;
}

function diffChildTable(table, beforeRows, afterRows) {
  const area = TABLE_LABELS[table] || prettify(table);
  const before = Array.isArray(beforeRows) ? beforeRows : [];
  const after = Array.isArray(afterRows) ? afterRows : [];
  const bm = new Map(); before.forEach((r, i) => { const k = rowKey(table, r, i); if (!bm.has(k)) bm.set(k, r); });
  const am = new Map(); after.forEach((r, i) => { const k = rowKey(table, r, i); if (!am.has(k)) am.set(k, r); });
  const lines = [];
  for (const [k] of am) if (!bm.has(k)) lines.push(`${area}: added ${k}`);
  for (const [k] of bm) if (!am.has(k)) lines.push(`${area}: removed ${k}`);
  for (const [k, ar] of am) {
    const br = bm.get(k);
    if (!br) continue;
    const ch = rowFieldChanges(br, ar);
    if (ch.length) lines.push(`${area}: ${k} changed (${ch.join(', ')})`);
  }
  return lines;
}

const MAX_LINES = 80;

// Compare two snapshots. Never throws; returns [] on malformed input.
function diffSnapshots(before, after) {
  const lines = [];
  try {
    const bf = (before && before.fields) || {};
    const af = (after && after.fields) || {};
    const cols = new Set([...Object.keys(bf), ...Object.keys(af)]);
    for (const col of cols) {
      if (SKIP_EST_COLS.has(col)) continue;
      const b = bf[col], a = af[col];
      if (sameValue(b, a)) continue;
      const label = EST_LABELS[col] || prettify(col);
      if (isLongText(col, b, a)) lines.push(`${label} changed`);
      else lines.push(`${label}: ${fmtValue(col, b)} -> ${fmtValue(col, a)}`);
    }
    const bc = (before && before.children) || {};
    const ac = (after && after.children) || {};
    const tables = new Set([...Object.keys(bc), ...Object.keys(ac)]);
    for (const t of tables) {
      lines.push(...diffChildTable(t, bc[t], ac[t]));
    }
  } catch (e) {
    return lines;
  }
  if (lines.length > MAX_LINES) {
    const extra = lines.length - MAX_LINES;
    return lines.slice(0, MAX_LINES).concat([`…and ${extra} more change${extra === 1 ? '' : 's'}`]);
  }
  return lines;
}

module.exports = { buildSnapshot, diffSnapshots };

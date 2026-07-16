'use strict';
// Resubmit change-capture.
//
// buildSnapshot(db, id) captures a JSON-serializable picture of a bid's priced
// INPUTS across the estimate row and its child tables (takeoff, cost inputs,
// wages, process-only, etc.). It is stored on submit and refreshed on each
// resubmit, so the next resubmit can diff against the prior snapshot.
//
// diffSnapshots(before, after) returns a flat array of short, human-readable
// strings describing what changed ("Profit %: 10% -> 12%", "Takeoff shapes:
// added W12X26", "Wage rates: Fitter changed (base_rate: 45 -> 48)").
//
// This module is READ-ONLY with respect to pricing: it never writes and its
// output is display/audit only, so a bug here cannot affect any calculation.

// Estimate-row columns that are not user inputs (identity, status, lifecycle,
// bookkeeping) and must not appear as "changes".
const SKIP_EST_COLS = new Set([
  'id', 'bid_number', 'status', 'confirmed', 'submitted_at', 'proposal_date',
  'created_at', 'updated_at', 'deleted_at', 'won_at', 'due_date', 'created_by',
  'revised_from_id', 'bid_type', 'is_alternate', 'parent_estimate_id',
  'alt_label', 'alt_position', 'job_number_assigned_by', 'job_number_assigned_at',
  'submit_snapshot'
]);

// Friendlier labels for common estimate fields. Anything not listed falls back
// to a prettified column name.
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

// Columns stored as decimals that represent true percentages (0.10 -> "10%").
const PERCENT_COLS = new Set([
  'oh_rate', 'contingency_rate', 'profit_rate', 'cgl_rate', 'sales_tax_rate',
  'ljb_op_rate', 'fica_pct', 'futa_pct', 'suta_pct', 'wc_pct', 'gl_pct',
  'umbrella_pct', 'auto_pct', 'pp_bond_pct', 'consumables_pct', 'fuel_pct', 'ohp_pct'
]);

// Long free-text fields: report "changed" rather than dumping old/new text.
const LONG_TEXT_COLS = new Set([
  'scope', 'notes', 'proposal_scope', 'proposal_exclusions', 'proposal_terms',
  'proposal_notes', 'proposal_to', 'drawing_numbers'
]);

// Per-row bookkeeping columns to ignore when diffing child rows.
const ROW_SKIP = new Set(['id', 'estimate_id', 'position', 'created_at', 'updated_at']);

// Child tables to snapshot, with the fields used to identify a row in messages.
// keyFields: first present, joined, forms the row's human key.
const CHILD_TABLES = [
  { area: 'Material overrides', table: 'material_overrides', key: ['section'] },
  { area: 'Takeoff shapes', table: 'takeoff_shapes', key: ['section_type', 'section_name'] },
  { area: 'Takeoff plates', table: 'takeoff_plates', key: ['thickness'] },
  { area: 'Takeoff misc', table: 'takeoff_misc', key: ['label', 'name', 'description', 'section'] },
  { area: 'Wage rates', table: 'wage_rates', key: ['role'] },
  { area: 'Cost input extras', table: 'estimate_extras', key: ['section', 'label', 'name'] },
  { area: 'Process-only lines', table: 'process_only_lines', key: ['label', 'description', 'shape', 'name'] },
  { area: 'Process-only add-costs', table: 'process_only_addcosts', key: ['label', 'description', 'name'] },
  { area: 'Site exclusions', table: 'estimate_site_exclusions', key: ['text', 'label'] },
  { area: 'Proposal manual lines', table: 'proposal_manual_lines', key: ['label', 'description', 'name'] }
];

function prettify(col) {
  return String(col).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function tableColumns(db, table) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name); }
  catch (e) { return []; }
}

function safeRows(db, table, id) {
  try {
    const cols = tableColumns(db, table);
    if (!cols.length) return [];
    const orderable = cols.includes('position') ? ' ORDER BY position, id'
      : (cols.includes('id') ? ' ORDER BY id' : '');
    return db.prepare(`SELECT * FROM ${table} WHERE estimate_id = ?${orderable}`).all(id);
  } catch (e) { return []; }
}

// Build the snapshot object. Never throws (returns a partial snapshot on error).
function buildSnapshot(db, id) {
  const snap = { fields: {}, children: {} };
  try {
    const est = db.prepare('SELECT * FROM estimates WHERE id = ?').get(id) || {};
    for (const k of Object.keys(est)) {
      if (!SKIP_EST_COLS.has(k)) snap.fields[k] = est[k];
    }
  } catch (e) { /* leave fields as-is */ }
  for (const cfg of CHILD_TABLES) {
    snap.children[cfg.table] = safeRows(db, cfg.table, id);
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

// Two values considered equal for diff purposes (blank-insensitive, numeric
// tolerance so 0.1 vs 0.1000001 rounding never registers as a change).
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

function rowKey(cfg, row, i) {
  if (!row) return `#${i + 1}`;
  // Shapes: the section name (e.g. "W12X26") is the meaningful identifier; the
  // section_type is only a fallback when a row has no name yet.
  if (cfg.table === 'takeoff_shapes') {
    if (!isBlank(row.section_name)) return String(row.section_name);
    if (!isBlank(row.section_type)) return String(row.section_type);
    return `#${i + 1}`;
  }
  for (const f of cfg.key) {
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

function diffChildTable(cfg, beforeRows, afterRows) {
  const before = Array.isArray(beforeRows) ? beforeRows : [];
  const after = Array.isArray(afterRows) ? afterRows : [];
  const bm = new Map(); before.forEach((r, i) => { const k = rowKey(cfg, r, i); if (!bm.has(k)) bm.set(k, r); });
  const am = new Map(); after.forEach((r, i) => { const k = rowKey(cfg, r, i); if (!am.has(k)) am.set(k, r); });
  const lines = [];
  for (const [k] of am) if (!bm.has(k)) lines.push(`${cfg.area}: added ${k}`);
  for (const [k] of bm) if (!am.has(k)) lines.push(`${cfg.area}: removed ${k}`);
  for (const [k, ar] of am) {
    const br = bm.get(k);
    if (!br) continue;
    const ch = rowFieldChanges(br, ar);
    if (ch.length) lines.push(`${cfg.area}: ${k} changed (${ch.join(', ')})`);
  }
  return lines;
}

const MAX_LINES = 60;

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
    for (const cfg of CHILD_TABLES) {
      lines.push(...diffChildTable(cfg, bc[cfg.table], ac[cfg.table]));
    }
  } catch (e) {
    return lines; // return whatever we gathered
  }
  if (lines.length > MAX_LINES) {
    const extra = lines.length - MAX_LINES;
    return lines.slice(0, MAX_LINES).concat([`…and ${extra} more change${extra === 1 ? '' : 's'}`]);
  }
  return lines;
}

module.exports = { buildSnapshot, diffSnapshots };

'use strict';
const express = require('express');
const db = require('../db');
const cw = require('../lib/company_wages');
const router = express.Router({ mergeParams: true });

const WAGE_COLS = [
  'base_rate', 'cash_in_lieu', 'fica_pct', 'futa_pct', 'suta_pct',
  'wc_pct', 'gl_pct', 'umbrella_pct', 'auto_pct', 'pp_bond_pct',
  'health_welfare', 'pension', 'consumables_pct', 'fuel_pct', 'ohp_pct',
  'wc_base_pct', 'wc_mod'
];
const TEXT_COLS = ['wc_class'];

const DEFAULT_ROLES = [
  'shop_worker', 'shop_half', 'ironworker', 'ironworker_half',
  'firewatch', 'firewatch_half', 'laborer', 'laborer_half',
  'pm', 'pm_half'
];

function respond(id, res) {
  const rows = db.prepare('SELECT * FROM wage_rates WHERE estimate_id = ?').all(id);
  // The company rates this estimate was copied from, so the tab can show which
  // cells were changed for this job. Empty on estimates made before company
  // rates existed.
  const versionId = rows.reduce((v, r) => v || r.company_version_id || null, null);
  const source = cw.getVersion(versionId);
  const latest = cw.latestVersion();
  res.json({
    rows,
    company: source ? { id: source.id, saved_at: source.saved_at, saved_by_name: source.saved_by_name, rows: cw.estimateRowsFor(source) } : null,
    latest_company: latest ? { id: latest.id, saved_at: latest.saved_at } : null
  });
}

// GET wage rates for an estimate. Creates defaults if missing.
router.get('/', (req, res) => {
  const id = Number(req.params.id);
  ensureDefaults(id);
  respond(id, res);
});

// PUT update wage rates (one role or many)
router.put('/', (req, res) => {
  const id = Number(req.params.id);
  const updates = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const tx = db.transaction(() => {
    for (const r of updates) {
      if (!r.role) continue;
      const existing = db.prepare('SELECT id FROM wage_rates WHERE estimate_id = ? AND role = ?').get(id, r.role);
      if (existing) {
        const sets = [];
        const vals = [];
        for (const c of WAGE_COLS) {
          if (Object.prototype.hasOwnProperty.call(r, c)) {
            sets.push(`${c} = ?`);
            // A blank box is saved as "Not set" (null), not as 0, so a missing
            // cost is never mistaken for a real zero. The math counts it as 0.
            vals.push(cw.toNum(r[c]));
          }
        }
        for (const c of TEXT_COLS) {
          if (Object.prototype.hasOwnProperty.call(r, c)) {
            sets.push(`${c} = ?`);
            vals.push(r[c] == null ? '' : String(r[c]).trim().slice(0, 20));
          }
        }
        if (sets.length) {
          vals.push(id, r.role);
          db.prepare(`UPDATE wage_rates SET ${sets.join(', ')} WHERE estimate_id = ? AND role = ?`).run(...vals);
        }
      } else {
        const cols = ['estimate_id', 'role', ...WAGE_COLS];
        const vals = [id, r.role, ...WAGE_COLS.map(c => cw.toNum(r[c]))];
        const placeholders = cols.map(() => '?').join(',');
        db.prepare(`INSERT INTO wage_rates (${cols.join(',')}) VALUES (${placeholders})`).run(...vals);
      }
      // When the policy base rate is entered, workers comp is base x mod. Rows
      // without a base rate (every estimate made before this) keep the combined
      // rate exactly as entered.
      const row = db.prepare('SELECT wc_pct, wc_base_pct, wc_mod FROM wage_rates WHERE estimate_id = ? AND role = ?').get(id, r.role);
      if (row && row.wc_base_pct != null) {
        db.prepare('UPDATE wage_rates SET wc_pct = ? WHERE estimate_id = ? AND role = ?').run(cw.effectiveWc(row), id, r.role);
      }
    }
    db.prepare("UPDATE estimates SET updated_at = datetime('now') WHERE id = ?").run(id);
  });
  tx();
  respond(id, res);
});

// POST reset: replace this estimate's wage rates with the current company rates.
// Changes Margin Analysis for this estimate only. Quoted price does not read
// wage rates, so it does not change.
router.post('/reset', (req, res) => {
  const id = Number(req.params.id);
  const v = cw.latestVersion();
  if (!v) return res.status(409).json({ error: 'No company wage rates have been saved yet. Set them in Settings first.' });
  cw.applyToEstimate(id, v);
  db.prepare("UPDATE estimates SET updated_at = datetime('now') WHERE id = ?").run(id);
  respond(id, res);
});

// Estimates that have never had wage rates get the original built-in defaults.
// New estimates are given company rates when they are created (see
// createEstimate), so this only fills in older estimates opened for the first
// time, which keep behaving exactly as they always have.
function ensureDefaults(estimateId) {
  const exists = db.prepare('SELECT COUNT(*) as n FROM wage_rates WHERE estimate_id = ?').get(estimateId).n;
  if (exists > 0) return;
  const insert = db.prepare('INSERT INTO wage_rates (estimate_id, role, base_rate, fica_pct, futa_pct, suta_pct, wc_pct, gl_pct, ohp_pct, consumables_pct, fuel_pct) VALUES (?, ?, ?, 0.0765, 0.006, 0.012, 0.07, 0.11, 0.10, ?, ?)');
  const tx = db.transaction(() => {
    for (const role of DEFAULT_ROLES) {
      const consumablesPct = role.startsWith('ironworker') ? 0.15 : 0;
      const fuelPct = role.startsWith('ironworker') ? 0.05 : 0;
      const baseRate = role.startsWith('shop_worker') || role.startsWith('ironworker') ? 28 : 0;
      const adjustedBase = role.endsWith('_half') ? baseRate / 2 : baseRate;
      insert.run(estimateId, role, adjustedBase, consumablesPct, fuelPct);
    }
  });
  tx();
}

module.exports = router;

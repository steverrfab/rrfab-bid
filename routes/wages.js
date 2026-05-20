'use strict';
const express = require('express');
const db = require('../db');
const router = express.Router({ mergeParams: true });

const WAGE_COLS = [
  'base_rate', 'cash_in_lieu', 'fica_pct', 'futa_pct', 'suta_pct',
  'wc_pct', 'gl_pct', 'umbrella_pct', 'auto_pct', 'pp_bond_pct',
  'health_welfare', 'pension', 'consumables_pct', 'fuel_pct', 'ohp_pct'
];

const DEFAULT_ROLES = [
  'shop_worker', 'shop_half', 'ironworker', 'ironworker_half',
  'firewatch', 'firewatch_half', 'laborer', 'laborer_half',
  'pm', 'pm_half'
];

// GET wage rates for an estimate. Creates defaults if missing.
router.get('/', (req, res) => {
  const id = Number(req.params.id);
  ensureDefaults(id);
  const rows = db.prepare('SELECT * FROM wage_rates WHERE estimate_id = ?').all(id);
  res.json({ rows });
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
            vals.push(+r[c] || 0);
          }
        }
        if (sets.length) {
          vals.push(id, r.role);
          db.prepare(`UPDATE wage_rates SET ${sets.join(', ')} WHERE estimate_id = ? AND role = ?`).run(...vals);
        }
      } else {
        const cols = ['estimate_id', 'role', ...WAGE_COLS];
        const vals = [id, r.role, ...WAGE_COLS.map(c => +r[c] || 0)];
        const placeholders = cols.map(() => '?').join(',');
        db.prepare(`INSERT INTO wage_rates (${cols.join(',')}) VALUES (${placeholders})`).run(...vals);
      }
    }
    db.prepare("UPDATE estimates SET updated_at = datetime('now') WHERE id = ?").run(id);
  });
  tx();
  const rows = db.prepare('SELECT * FROM wage_rates WHERE estimate_id = ?').all(id);
  res.json({ rows });
});

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

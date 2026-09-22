'use strict';
// ===== INTEGRATION API (server to server) =====
// The door the CRM comes in through. Mounted at /api/integration and guarded by the
// shared CRM_KEY in an X-Integration-Key header, the same pattern the tracker feeds
// use. A browser never reaches these: the CRM's own server calls them.
//
// What lives here is the unlinked queue. `estimates.client_gc` has always been free
// text, so most bids carry a typed GC name and no company id. These two endpoints let
// the CRM list those names and point them at real companies, one confirmed link at a
// time.
//
// Nothing here touches a price. The only columns written are crm_company_id and
// crm_company_name, which exist to label a bid, not to value it. No estimate is
// repriced, no calc runs, and lib/calc.js is not involved. (CLAUDE.md rule 2.)
const express = require('express');
const db = require('../db');
const { requireIntegrationKey } = require('../lib/integration_key');
const { groupKey } = require('../lib/company_names');

const router = express.Router();

router.use(requireIntegrationKey('CRM_KEY'));

// A real bid, by the same definition the Estimates list and the bids-for-company feed
// use. Kept identical on purpose: a name that shows "9 bids" here has to be the same 9
// that turn up on the company's Bids tab once it is linked.
const REAL_BID = `e.deleted_at IS NULL AND e.confirmed = 1 AND e.is_alternate = 0
    AND e.change_order_id IS NULL AND (e.bid_type = 'real' OR e.bid_type IS NULL)`;

// GET /api/integration/unlinked-clients
//
// Every typed GC name with no company behind it, grouped so different spellings of one
// name arrive as one row. "Scott long" and "Scott Long" are one GC who was typed two
// ways; they come back as a single entry carrying both spellings, so linking them is
// one decision instead of two, and neither spelling can end up pointing somewhere else.
//
// The display name is the spelling used on the most bids, ties going to the one that
// looks most deliberate (a capital letter beats none).
router.get('/unlinked-clients', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT e.id, e.client_gc, e.project_name, e.bid_number, e.status,
             COALESCE(e.submitted_at, e.bid_date, e.created_at) AS sort_at
      FROM estimates e
      WHERE (e.crm_company_id IS NULL OR e.crm_company_id = '')
        AND e.client_gc IS NOT NULL AND TRIM(e.client_gc) <> ''
        AND ${REAL_BID}
      ORDER BY sort_at DESC, e.id DESC`).all();

    const groups = new Map();
    for (const r of rows) {
      const name = String(r.client_gc).trim();
      const key = groupKey(name);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, { key, spellings: new Map(), bids: 0, won: 0, last_bid_at: null, samples: [] });
      const g = groups.get(key);
      g.spellings.set(name, (g.spellings.get(name) || 0) + 1);
      g.bids += 1;
      if (r.status === 'Won') g.won += 1;
      if (!g.last_bid_at && r.sort_at) g.last_bid_at = r.sort_at;
      if (g.samples.length < 3) g.samples.push({ id: r.id, project_name: r.project_name, bid_number: r.bid_number });
    }

    // Price the bids behind each name, best effort. This is what makes Harkins at $2.1M
    // sort above a name with one small bid, so the queue is worked in a useful order.
    // A bid that will not price counts as zero rather than failing the whole screen.
    const { loadFullEstimate, sellPretax } = require('./estimates');
    const valueOf = (id) => {
      try { const b = loadFullEstimate(id); return b ? (+sellPretax(b) || 0) : 0; } catch { return 0; }
    };
    const valueByKey = new Map();
    for (const r of rows) {
      const key = groupKey(String(r.client_gc).trim());
      if (!key) continue;
      valueByKey.set(key, (valueByKey.get(key) || 0) + valueOf(r.id));
    }

    const out = [...groups.values()].map(g => {
      // Most bids wins. On a tie, the spelling that looks most deliberate: "Scott Long"
      // over "Scott long" over "scott  long,". Capitals first, then the tidier string.
      const caps = (n) => (n.match(/[A-Z]/g) || []).length;
      const spellings = [...g.spellings.entries()]
        .sort((a, b) => b[1] - a[1] || caps(b[0]) - caps(a[0]) || a[0].length - b[0].length || a[0].localeCompare(b[0]));
      return {
        key: g.key,
        name: spellings[0][0],
        // Every exact spelling in this group. The CRM hands these straight back to
        // link-company, so the update only ever touches names that were actually seen.
        names: spellings.map(([n]) => n),
        spellings: spellings.map(([n, count]) => ({ name: n, bids: count })),
        bids: g.bids,
        won: g.won,
        total_value: Math.round(valueByKey.get(g.key) || 0),
        last_bid_at: g.last_bid_at,
        samples: g.samples,
      };
    }).sort((a, b) => b.total_value - a.total_value || b.bids - a.bids || a.name.localeCompare(b.name));

    res.json({ rows: out, unlinked_bids: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/integration/link-company  { names: [...], crm_company_id, crm_company_name }
//
// Point every bid carrying any of these exact typed names at one CRM company. The names
// come from the queue above, so nothing is matched loosely here: the server updates the
// exact strings it was handed and nothing else. A person confirmed this link; automatic
// matching was measured and got it wrong (Abc Construction paired with Hoar).
//
// Only bids that have no company yet are touched, so running it twice changes nothing
// the second time and a link someone set by hand in the bid tool is never overwritten.
router.put('/link-company', (req, res) => {
  try {
    const names = Array.isArray(req.body?.names) ? req.body.names.map(n => String(n || '').trim()).filter(Boolean) : [];
    const companyId = String(req.body?.crm_company_id || '').trim();
    const companyName = String(req.body?.crm_company_name || '').trim();
    if (!names.length) return res.status(400).json({ error: 'names required' });
    if (!companyId) return res.status(400).json({ error: 'crm_company_id required' });
    if (!companyName) return res.status(400).json({ error: 'crm_company_name required' });

    const marks = names.map(() => '?').join(',');
    const run = db.transaction(() => {
      const r = db.prepare(`
        UPDATE estimates
        SET crm_company_id = ?, crm_company_name = ?
        WHERE (crm_company_id IS NULL OR crm_company_id = '')
          AND TRIM(client_gc) IN (${marks})`).run(companyId, companyName, ...names);
      return r.changes;
    });
    const updated = run();
    console.log(`[integration] linked ${updated} bid(s) typed as ${names.map(n => JSON.stringify(n)).join(', ')} to CRM company ${companyName}`);
    res.json({ updated, crm_company_id: companyId, crm_company_name: companyName });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/integration/unlink-company  { names: [...] }
// Undo. Puts those bids back to a typed name with no company, so a wrong link made from
// the queue can be taken off without opening each bid.
router.put('/unlink-company', (req, res) => {
  try {
    const names = Array.isArray(req.body?.names) ? req.body.names.map(n => String(n || '').trim()).filter(Boolean) : [];
    if (!names.length) return res.status(400).json({ error: 'names required' });
    const marks = names.map(() => '?').join(',');
    const r = db.prepare(`
      UPDATE estimates SET crm_company_id = NULL, crm_company_name = NULL
      WHERE TRIM(client_gc) IN (${marks})`).run(...names);
    console.log(`[integration] unlinked ${r.changes} bid(s) typed as ${names.join(', ')}`);
    res.json({ updated: r.changes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

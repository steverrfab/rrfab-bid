'use strict';
const express = require('express');
const router = express.Router({ mergeParams: true });
const db = require('../db');
const { requireAuth } = require('../lib/auth');
const { loadFullEstimate } = require('./estimates');
const { generateSov } = require('../lib/sov_pdf');

router.use(requireAuth);

// Build auto-generated SOV line items from computed totals.
// Mirrors the proposal line items structure.
function autoGenerateItems(bundle) {
  const e = bundle.estimate;
  const c = bundle.computed;

  function mf() {
    return (1 + (+e.oh_rate || 0))
         * (1 + (+e.contingency_rate || 0))
         * (1 + (+e.profit_rate || 0))
         * (1 + (+e.cgl_rate || 0));
  }
  const m = mf();

  const items = [
    { item_no: '1', description: 'Structural Steel Material — Furnished', scheduled_value: c.materialPrice * m },
    { item_no: '2', description: 'Shop Fabrication and Finishes',         scheduled_value: (c.fabHours + c.paint + c.consumables + c.handling) * m },
    { item_no: '3', description: 'Detailing and PE-Stamped Shop Drawings', scheduled_value: (((+e.struct_detailing||0)*(+e.struct_detailing_qty||1)) + ((+e.misc_detailing||0)*(+e.misc_detailing_qty||1)) + ((+e.pe_stamp||0)*(+e.pe_stamp_qty||1))) * m },
    { item_no: '4', description: 'Freight to Jobsite',                    scheduled_value: (+e.freight || 0) * (+e.freight_qty || 1) * m },
    { item_no: '5', description: 'Field Erection, Equipment, and Rigging', scheduled_value: (c.erectionLabor + (+e.erection_equip || 0) * (+e.erection_equip_qty || 1)) * m },
    { item_no: '6', description: 'Galvanizing',                           scheduled_value: c.galv * m },
    { item_no: '7', description: 'Processing Labor',                      scheduled_value: c.processingLabor * m }
  ];

  // Item 0: project scope (and drawing numbers), so the SOV reflects the scope.
  const scopeText = (e.proposal_scope || e.scope || '').trim();
  const drawings = (e.drawing_numbers || '').trim();
  if (scopeText || drawings) {
    items.unshift({
      item_no: '0',
      description: 'Scope of Work: ' + (scopeText || '(see proposal)') + (drawings ? '  |  Drawings: ' + drawings : ''),
      scheduled_value: 0
    });
  }

  // Add sub items if non-zero
  let next = 8;
  if ((+e.sub_joist_deck || 0) > 0) {
    items.push({ item_no: String(next++), description: 'Joist and Deck — by Subcontractor', scheduled_value: (+e.sub_joist_deck || 0) * (+e.sub_joist_deck_qty || 1) * m });
  }
  if ((+e.sub_erection || 0) > 0) {
    items.push({ item_no: String(next++), description: 'Erection — by Subcontractor', scheduled_value: (+e.sub_erection || 0) * (+e.sub_erection_qty || 1) * m });
  }

  // Add any estimate extras
  const extras = bundle.extras || [];
  extras.forEach(x => {
    const amt = (+x.qty || 0) * (+x.rate || 0) * m;
    if (amt > 0) {
      items.push({ item_no: String(next++), description: x.description || 'Additional Item', scheduled_value: amt });
    }
  });

  // Filter out zero-value items (except item 1 which should always show)
  return items.filter((it, i) => i === 0 || it.scheduled_value > 0)
    .map((it, i) => ({ ...it, position: i }));
}

// GET /api/estimates/:id/sov — list items, auto-generate if none exist yet
router.get('/', (req, res) => {
  const id = Number(req.params.id);
  const est = db.prepare('SELECT id FROM estimates WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!est) return res.status(404).json({ error: 'not found' });

  let items = db.prepare('SELECT * FROM sov_items WHERE estimate_id = ? ORDER BY position, id').all(id);
  if (items.length === 0) {
    const bundle = loadFullEstimate(id);
    if (!bundle) return res.status(404).json({ error: 'not found' });
    const auto = autoGenerateItems(bundle);
    const insert = db.prepare(
      'INSERT INTO sov_items (estimate_id, item_no, description, scheduled_value, position) VALUES (?,?,?,?,?)'
    );
    const tx = db.transaction(arr => {
      for (const it of arr) insert.run(id, it.item_no, it.description, it.scheduled_value, it.position);
    });
    tx(auto);
    items = db.prepare('SELECT * FROM sov_items WHERE estimate_id = ? ORDER BY position, id').all(id);
  }
  res.json(items);
});

// PUT /api/estimates/:id/sov — replace all items
router.put('/', (req, res) => {
  const id = Number(req.params.id);
  const est = db.prepare('SELECT id FROM estimates WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!est) return res.status(404).json({ error: 'not found' });

  const items = Array.isArray(req.body) ? req.body : [];
  const del = db.prepare('DELETE FROM sov_items WHERE estimate_id = ?');
  const ins = db.prepare(
    'INSERT INTO sov_items (estimate_id, item_no, description, scheduled_value, position, prev_completed, this_period, stored_materials, retainage_pct) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  const tx = db.transaction(arr => {
    del.run(id);
    arr.forEach((it, i) => ins.run(
      id, it.item_no || String(i + 1), it.description || '', +it.scheduled_value || 0, i,
      +it.prev_completed || 0, +it.this_period || 0, +it.stored_materials || 0, +it.retainage_pct || 0
    ));
  });
  tx(items);
  res.json(db.prepare('SELECT * FROM sov_items WHERE estimate_id = ? ORDER BY position, id').all(id));
});

// POST /api/estimates/:id/sov/regenerate — discard and rebuild from current computed totals
router.post('/regenerate', (req, res) => {
  const id = Number(req.params.id);
  const bundle = loadFullEstimate(id);
  if (!bundle) return res.status(404).json({ error: 'not found' });

  const auto = autoGenerateItems(bundle);
  const del = db.prepare('DELETE FROM sov_items WHERE estimate_id = ?');
  const ins = db.prepare(
    'INSERT INTO sov_items (estimate_id, item_no, description, scheduled_value, position) VALUES (?,?,?,?,?)'
  );
  const tx = db.transaction(arr => {
    del.run(id);
    for (const it of arr) ins.run(id, it.item_no, it.description, it.scheduled_value, it.position);
  });
  tx(auto);
  res.json(db.prepare('SELECT * FROM sov_items WHERE estimate_id = ? ORDER BY position, id').all(id));
});

// GET /api/estimates/:id/sov/pdf — download SOV PDF
router.get('/pdf', (req, res) => {
  const id = Number(req.params.id);
  const bundle = loadFullEstimate(id);
  if (!bundle) return res.status(404).json({ error: 'not found' });

  let items = db.prepare('SELECT * FROM sov_items WHERE estimate_id = ? ORDER BY position, id').all(id);
  if (items.length === 0) {
    items = autoGenerateItems(bundle).map((it, i) => ({ ...it, id: i, estimate_id: id }));
  }
  bundle.sovItems = items;
  generateSov(res, bundle);
});

// GET /api/estimates/:id/sov/excel — download SOV as Excel (AIA G703 format)
router.get('/excel', async (req, res) => {
  const id = Number(req.params.id);
  const bundle = loadFullEstimate(id);
  if (!bundle) return res.status(404).json({ error: 'not found' });
  let items = db.prepare('SELECT * FROM sov_items WHERE estimate_id = ? ORDER BY position, id').all(id);
  if (items.length === 0) {
    items = autoGenerateItems(bundle).map((it, i) => ({ ...it, id: i, estimate_id: id }));
  }
  const e = bundle.estimate;

  try {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('SOV');

    // Project info rows
    ws.addRow(['PROJECT:', e.project_name || '', '', 'CONTRACT NO:', e.bid_number || '']);
    ws.addRow(['OWNER / GC:', e.client_gc || '', '', 'DATE:', new Date().toLocaleDateString()]);
    ws.addRow([]);

    // G703 header
    const hdr = ws.addRow([
      'Item No.', 'Description of Work', 'Scheduled Value (D)',
      'Prev. Completed (G)', 'This Period (H)', 'Stored Materials (I)',
      'Total Completed & Stored (J)', '% (J/D)', 'Balance to Finish', 'Retainage %'
    ]);
    hdr.eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D1B35' } };
      cell.alignment = { horizontal: 'center', wrapText: true };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFFFFFFF' } } };
    });

    // Data rows
    let totalSched = 0, totalPrev = 0, totalThis = 0, totalStored = 0;
    items.forEach(it => {
      const sched = +it.scheduled_value || 0;
      const prev  = +it.prev_completed || 0;
      const thisp = +it.this_period || 0;
      const stored = +it.stored_materials || 0;
      const total = prev + thisp + stored;
      const pct = sched > 0 ? (total / sched) : 0;
      const balance = sched - total;
      totalSched += sched; totalPrev += prev; totalThis += thisp; totalStored += stored;

      const row = ws.addRow([
        it.item_no, it.description,
        sched, prev, thisp, stored,
        total,
        pct,
        balance,
        +it.retainage_pct || 0
      ]);
      row.getCell(3).numFmt = '$#,##0.00';
      row.getCell(4).numFmt = '$#,##0.00';
      row.getCell(5).numFmt = '$#,##0.00';
      row.getCell(6).numFmt = '$#,##0.00';
      row.getCell(7).numFmt = '$#,##0.00';
      row.getCell(8).numFmt = '0.0%';
      row.getCell(9).numFmt = '$#,##0.00';
      row.getCell(10).numFmt = '0.0%';
      row.eachCell(cell => {
        cell.border = { bottom: { style: 'hair', color: { argb: 'FFCCCCCC' } } };
      });
    });

    // Totals row
    const totalRow = ws.addRow([
      '', 'TOTALS',
      totalSched, totalPrev, totalThis, totalStored,
      totalPrev + totalThis + totalStored,
      totalSched > 0 ? (totalPrev + totalThis + totalStored) / totalSched : 0,
      totalSched - (totalPrev + totalThis + totalStored),
      ''
    ]);
    totalRow.eachCell(cell => {
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8ECF2' } };
    });
    totalRow.getCell(3).numFmt = '$#,##0.00';
    totalRow.getCell(4).numFmt = '$#,##0.00';
    totalRow.getCell(5).numFmt = '$#,##0.00';
    totalRow.getCell(6).numFmt = '$#,##0.00';
    totalRow.getCell(7).numFmt = '$#,##0.00';
    totalRow.getCell(8).numFmt = '0.0%';
    totalRow.getCell(9).numFmt = '$#,##0.00';

    // Column widths
    ws.columns = [
      { width: 10 }, { width: 40 }, { width: 18 }, { width: 18 }, { width: 16 },
      { width: 18 }, { width: 22 }, { width: 10 }, { width: 18 }, { width: 14 }
    ];

    const filename = (e.project_name || 'SOV').replace(/[^a-zA-Z0-9_\-. ]/g, '').trim();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="SOV_' + filename + '.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[sov] excel error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

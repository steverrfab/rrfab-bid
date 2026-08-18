'use strict';
// Reports: bid activity + dollar volume, on screen and as an Excel download.
//
// Admin only — mounted behind requireAdmin in server.js, so there is no role
// branching in here. Company-wide dollar volume is not estimator-visible.
//
// Every number comes from lib/report_data.js, the same module the dashboard
// summary uses, so a report can never disagree with the dashboard cards.

const express = require('express');
const db = require('../db');
const { loadFullEstimate } = require('./estimates');
const { reportRow, dayOf, inRange, monthOf } = require('../lib/report_data');

const router = express.Router();

// Bids that count. Identical filter to /api/estimates/summary: no deleted bids,
// no unsaved (confirmed = 0) bids, no alternates, and only 'real' bid types —
// Test/Demo/Superseded stay in the system but never hit a report. NULL bid_type
// is treated as 'real' so legacy rows keep counting.
const VISIBLE = `
  SELECT e.id, e.created_by, u.name AS owner_name, u.email AS owner_email
  FROM estimates e
  LEFT JOIN users u ON u.id = e.created_by
  WHERE e.deleted_at IS NULL
    AND e.confirmed = 1
    AND e.is_alternate = 0
    AND (e.bid_type = 'real' OR e.bid_type IS NULL)
`;

function parseRange(query) {
  const norm = (v) => {
    const s = String(v || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  };
  let from = norm(query.from);
  let to = norm(query.to);
  // Tolerate a backwards range rather than silently returning nothing.
  if (from && to && from > to) [from, to] = [to, from];
  return { from, to };
}

// Narrowing filters, all optional. These are applied BEFORE the period logic,
// so every number on the page (and in the workbook) reflects them: filter to one
// GC and the win rate is that GC's win rate, not the company's.
function parseFilters(query) {
  const s = (v) => String(v || '').trim();
  return {
    status: s(query.status),       // Draft | Submitted | Won | Lost
    customer: s(query.customer),   // exact client_gc, or '(no customer)'
    owner: s(query.owner),         // exact owner_name
    q: s(query.q).toLowerCase()    // substring of project / bid # / job #
  };
}

function applyFilters(rows, f) {
  return rows.filter(r => {
    if (f.status && (r.status || 'Draft') !== f.status) return false;
    if (f.customer) {
      const c = (r.client_gc || '').trim() || '(no customer)';
      if (c !== f.customer) return false;
    }
    if (f.owner && (r.owner_name || '') !== f.owner) return false;
    if (f.q) {
      const hay = [r.project_name, r.bid_number, r.job_number, r.client_gc]
        .map(v => String(v || '').toLowerCase()).join(' ');
      if (!hay.includes(f.q)) return false;
    }
    return true;
  });
}

// Dropdown options come from the UNFILTERED set, so picking a customer does not
// empty out the other dropdowns and strand you with no way back.
function buildFacets(all) {
  const uniq = (vals) => [...new Set(vals.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return {
    statuses: uniq(all.map(r => r.status || 'Draft')),
    customers: uniq(all.map(r => (r.client_gc || '').trim() || '(no customer)')),
    owners: uniq(all.map(r => r.owner_name))
  };
}

// Loads every visible bid and computes its financials.
//
// This is one loadFullEstimate() call per bid, the same cost the dashboard
// summary already pays. Fine at the current bid count; if this ever gets slow,
// the fix is caching revenue/profit on the estimates row at save time rather
// than trimming the report.
function loadRows() {
  const out = [];
  for (const r of db.prepare(VISIBLE).all()) {
    const bundle = loadFullEstimate(r.id);
    if (!bundle) continue;
    out.push(reportRow(bundle, { name: r.owner_name, email: r.owner_email }));
  }
  return out;
}

const money = (n) => Math.round((+n || 0) * 100) / 100;
const sum = (rows, key) => money(rows.reduce((t, r) => t + (+r[key] || 0), 0));

// A bid is "lost" on... nothing. There is no lost_at column, so a Lost bid is
// dated by its bid date (the decision date), falling back to created.
//
// This deliberately mirrors Dashboard.jsx exactly. An earlier version here used
// submitted_at first, which quietly produced a different Lost count than the
// dashboard card for the same period. Do not "improve" this in isolation: if
// the rule changes it changes in both places, or the two screens start
// disagreeing about the same bids.
function lostDate(r) {
  return r.bid_date || r.created_at;
}

function buildReport(all, from, to) {
  // Activity in the window. These four rules mirror the dashboard cards in
  // Dashboard.jsx line for line, because the whole point of this page is that
  // it agrees with the dashboard. Each bucket filters on its OWN date, and a
  // bid can legitimately land in more than one.
  //
  //   Created   = every bid not Lost, by created date  (dashboard "Estimated")
  //   Submitted = bids CURRENTLY in Submitted status, by submitted date
  //   Won       = bids currently Won, by win date
  //   Lost      = bids currently Lost, by bid date then created date
  //
  // Note Submitted keys off current status, so a bid submitted and then won in
  // the same period counts under Won, not both. That is the dashboard's rule.
  const created   = all.filter(r => (r.status || 'Draft') !== 'Lost' && inRange(r.created_at, from, to));
  const submitted = all.filter(r => r.status === 'Submitted' && inRange(r.submitted_at, from, to));
  const won       = all.filter(r => r.status === 'Won'  && inRange(r.won_at, from, to));
  const lost      = all.filter(r => r.status === 'Lost' && inRange(lostDate(r), from, to));

  const touchedIds = new Set([...created, ...submitted, ...won, ...lost].map(r => r.id));
  const detail = all
    .filter(r => touchedIds.has(r.id))
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

  // Open pipeline is a snapshot of right now, not a slice of the window —
  // what is out to bid and still undecided, whenever it was submitted.
  const openRows = all.filter(r => r.status === 'Submitted');

  const decided = won.length + lost.length;
  const wonValue = sum(won, 'revenue');

  const summary = {
    from, to,
    bids_created: created.length,
    bids_submitted: submitted.length,
    bids_won: won.length,
    bids_lost: lost.length,
    win_rate: decided > 0 ? won.length / decided : null,   // null = nothing decided yet
    value_submitted: sum(submitted, 'revenue'),
    value_won: wonValue,
    value_lost: sum(lost, 'revenue'),
    profit_won: sum(won, 'profit'),
    margin_won: wonValue > 0 ? sum(won, 'profit') / wonValue : null,
    avg_bid_size: submitted.length ? money(sum(submitted, 'revenue') / submitted.length) : 0,
    open_pipeline_count: openRows.length,
    open_pipeline_value: sum(openRows, 'revenue')
  };

  // --- By customer -----------------------------------------------------------
  const custMap = new Map();
  for (const r of detail) {
    const name = (r.client_gc || '').trim() || '(no customer)';
    if (!custMap.has(name)) {
      custMap.set(name, { customer: name, bids: 0, won: 0, lost: 0, value_bid: 0, value_won: 0, profit_won: 0 });
    }
    const c = custMap.get(name);
    c.bids += 1;
    c.value_bid += +r.revenue || 0;
    if (won.some(w => w.id === r.id))  { c.won += 1; c.value_won += +r.revenue || 0; c.profit_won += +r.profit || 0; }
    if (lost.some(l => l.id === r.id)) { c.lost += 1; }
  }
  const byCustomer = [...custMap.values()].map(c => ({
    ...c,
    value_bid: money(c.value_bid),
    value_won: money(c.value_won),
    profit_won: money(c.profit_won),
    win_rate: (c.won + c.lost) > 0 ? c.won / (c.won + c.lost) : null
  })).sort((a, b) => b.value_bid - a.value_bid);

  // --- By month --------------------------------------------------------------
  // Each bid lands in a month per event, so one bid can appear in the created
  // column of one month and the won column of another. That is intended: the
  // columns answer different questions.
  const monthMap = new Map();
  const bucket = (m) => {
    if (!m) return null;
    if (!monthMap.has(m)) {
      monthMap.set(m, { month: m, created: 0, submitted: 0, won: 0, value_submitted: 0, value_won: 0, profit_won: 0 });
    }
    return monthMap.get(m);
  };
  for (const r of created)   { const b = bucket(monthOf(r.created_at));   if (b) b.created += 1; }
  for (const r of submitted) { const b = bucket(monthOf(r.submitted_at)); if (b) { b.submitted += 1; b.value_submitted += +r.revenue || 0; } }
  for (const r of won)       { const b = bucket(monthOf(r.won_at));       if (b) { b.won += 1; b.value_won += +r.revenue || 0; b.profit_won += +r.profit || 0; } }
  const byMonth = [...monthMap.values()].map(m => ({
    ...m,
    value_submitted: money(m.value_submitted),
    value_won: money(m.value_won),
    profit_won: money(m.profit_won)
  })).sort((a, b) => a.month.localeCompare(b.month));

  const wonIds = new Set(won.map(r => r.id));
  const lostIds = new Set(lost.map(r => r.id));

  return {
    summary,
    detail: detail.map(r => ({
      bid_number: r.bid_number,
      job_number: r.job_number,
      project_name: r.project_name,
      client_gc: r.client_gc,
      owner_name: r.owner_name,
      status: r.status,
      job_type_label: r.job_type === 'process_only' ? 'Process' : 'Full',
      job_type: r.job_type,
      bid_date: dayOf(r.bid_date),
      due_date: dayOf(r.due_date),
      created_at: dayOf(r.created_at),
      submitted_at: dayOf(r.submitted_at),
      won_at: dayOf(r.won_at),
      revenue: money(r.revenue),
      profit: money(r.profit),
      margin: (+r.revenue || 0) > 0 ? (+r.profit || 0) / (+r.revenue || 0) : null,
      counted_won: wonIds.has(r.id),
      counted_lost: lostIds.has(r.id)
    })),
    byCustomer,
    byMonth
  };
}

// One place that turns a querystring into a finished report, so the JSON page
// and the Excel download can never show different numbers for the same filters.
function runReport(query) {
  const { from, to } = parseRange(query);
  const filters = parseFilters(query);
  const all = loadRows();
  const rep = buildReport(applyFilters(all, filters), from, to);
  return { ...rep, facets: buildFacets(all), filters: { ...filters, from, to } };
}

// ---- JSON (powers the on-screen cards and tables) ----
router.get('/bids.json', (req, res) => {
  res.json(runReport(req.query));
});

// ---- Excel download ----
// Styling mirrors the SOV export (routes/sov.js) so the two downloads look like
// they came out of the same app.
const NAVY = 'FF0D1B35';
const BAND = 'FFE8ECF2';
const MONEY = '$#,##0';
const PCT = '0.0%';

function styleHeader(row) {
  row.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    cell.alignment = { horizontal: 'center', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFFFFFFF' } } };
  });
}

// includeEmpty so the band runs solid across the row instead of breaking at
// every blank cell.
function styleTotals(row, width) {
  for (let i = 1; i <= width; i++) {
    const cell = row.getCell(i);
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND } };
  }
}

// Applies a number format to a set of columns across every data row.
function formatCols(ws, firstDataRow, cols, fmt) {
  for (let i = firstDataRow; i <= ws.rowCount; i++) {
    for (const c of cols) ws.getRow(i).getCell(c).numFmt = fmt;
  }
}

router.get('/bids.xlsx', async (req, res) => {
  const { from, to } = parseRange(req.query);
  try {
    const rep = runReport(req.query);
    const f = rep.filters;
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'R&R Bid';
    wb.created = new Date();

    const label = (from || to)
      ? `${from || 'start'} to ${to || 'today'}`
      : 'All time';

    // ---- Sheet 1: Summary ----
    const s = wb.addWorksheet('Summary');
    s.columns = [{ width: 30 }, { width: 20 }];
    const title = s.addRow(['R&R Fabrication — Bid Report']);
    title.font = { bold: true, size: 14 };
    s.addRow(['Period', label]);
    s.addRow(['Generated', new Date().toLocaleString()]);
    // Print whatever the screen was filtered to, so a saved workbook is always
    // self-explanatory and nobody argues about why two exports disagree.
    if (f.status)   s.addRow(['Status filter', f.status]);
    if (f.customer) s.addRow(['Customer filter', f.customer]);
    if (f.owner)    s.addRow(['Estimator filter', f.owner]);
    if (f.q)        s.addRow(['Search', f.q]);
    s.addRow([]);

    const m = rep.summary;
    const block = (heading, pairs) => {
      const h = s.addRow([heading, '']);
      styleHeader(h);
      for (const [k, v, fmt] of pairs) {
        const row = s.addRow([k, v == null ? 'n/a' : v]);
        if (fmt && v != null) row.getCell(2).numFmt = fmt;
      }
      s.addRow([]);
    };

    block('Bid activity', [
      ['Bids created', m.bids_created],
      ['Bids submitted', m.bids_submitted],
      ['Bids won', m.bids_won],
      ['Bids lost', m.bids_lost],
      ['Win rate (of decided)', m.win_rate, PCT]
    ]);
    block('Dollar volume', [
      ['Value submitted', m.value_submitted, MONEY],
      ['Value won', m.value_won, MONEY],
      ['Value lost', m.value_lost, MONEY],
      ['Average bid size', m.avg_bid_size, MONEY],
      ['Profit on won work', m.profit_won, MONEY],
      ['Margin on won work', m.margin_won, PCT]
    ]);
    block('Open pipeline (as of today)', [
      ['Bids out, undecided', m.open_pipeline_count],
      ['Value out, undecided', m.open_pipeline_value, MONEY]
    ]);
    s.addRow(['All figures are pre-tax. Sales tax is a pass-through — see the Tax Summary in the app.']);
    s.addRow(['Test, demo, superseded and alternate bids are excluded.']);

    // ---- Sheet 2: Bid Detail ----
    const d = wb.addWorksheet('Bid Detail');
    d.columns = [
      { width: 10 }, { width: 10 }, { width: 34 }, { width: 26 }, { width: 18 },
      { width: 12 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 12 },
      { width: 12 }, { width: 14 }, { width: 14 }, { width: 10 }
    ];
    styleHeader(d.addRow([
      'Bid #', 'Job #', 'Project', 'Customer / GC', 'Owner',
      'Status', 'Type', 'Bid Date', 'Due', 'Created',
      'Submitted', 'Amount', 'Profit', 'Margin'
    ]));
    d.views = [{ state: 'frozen', ySplit: 1 }];
    for (const r of rep.detail) {
      d.addRow([
        r.bid_number, r.job_number, r.project_name, r.client_gc, r.owner_name,
        r.status, r.job_type === 'process_only' ? 'Process' : 'Full',
        r.bid_date, r.due_date, r.created_at, r.submitted_at,
        r.revenue, r.profit, r.margin
      ]);
    }
    formatCols(d, 2, [12, 13], MONEY);
    formatCols(d, 2, [14], PCT);
    const detailTotal = rep.detail.reduce((t, r) => t + r.revenue, 0);
    const detailProfit = rep.detail.reduce((t, r) => t + r.profit, 0);
    styleTotals(d.addRow([
      '', '', `${rep.detail.length} bids`, '', '', '', '', '', '', '', 'TOTAL',
      detailTotal, detailProfit,
      detailTotal > 0 ? detailProfit / detailTotal : null
    ]), 14);
    d.getRow(d.rowCount).getCell(14).numFmt = PCT;
    d.getRow(d.rowCount).getCell(12).numFmt = MONEY;
    d.getRow(d.rowCount).getCell(13).numFmt = MONEY;
    d.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 14 } };

    // ---- Sheet 3: By Customer ----
    const c = wb.addWorksheet('By Customer');
    c.columns = [{ width: 32 }, { width: 10 }, { width: 10 }, { width: 10 },
                 { width: 12 }, { width: 16 }, { width: 16 }, { width: 16 }];
    styleHeader(c.addRow(['Customer / GC', 'Bids', 'Won', 'Lost', 'Win Rate',
                          'Value Bid', 'Value Won', 'Profit Won']));
    c.views = [{ state: 'frozen', ySplit: 1 }];
    for (const r of rep.byCustomer) {
      c.addRow([r.customer, r.bids, r.won, r.lost, r.win_rate, r.value_bid, r.value_won, r.profit_won]);
    }
    formatCols(c, 2, [6, 7, 8], MONEY);
    formatCols(c, 2, [5], PCT);
    const ct = (k) => rep.byCustomer.reduce((t, r) => t + r[k], 0);
    styleTotals(c.addRow(['TOTAL', ct('bids'), ct('won'), ct('lost'), null,
                          ct('value_bid'), ct('value_won'), ct('profit_won')]), 8);
    for (const col of [6, 7, 8]) c.getRow(c.rowCount).getCell(col).numFmt = MONEY;

    // ---- Sheet 4: By Month ----
    const mo = wb.addWorksheet('By Month');
    mo.columns = [{ width: 12 }, { width: 12 }, { width: 12 }, { width: 10 },
                  { width: 18 }, { width: 18 }, { width: 18 }];
    styleHeader(mo.addRow(['Month', 'Created', 'Submitted', 'Won',
                           'Value Submitted', 'Value Won', 'Profit Won']));
    mo.views = [{ state: 'frozen', ySplit: 1 }];
    for (const r of rep.byMonth) {
      mo.addRow([r.month, r.created, r.submitted, r.won, r.value_submitted, r.value_won, r.profit_won]);
    }
    formatCols(mo, 2, [5, 6, 7], MONEY);
    const mt = (k) => rep.byMonth.reduce((t, r) => t + r[k], 0);
    styleTotals(mo.addRow(['TOTAL', mt('created'), mt('submitted'), mt('won'),
                           mt('value_submitted'), mt('value_won'), mt('profit_won')]), 7);
    for (const col of [5, 6, 7]) mo.getRow(mo.rowCount).getCell(col).numFmt = MONEY;

    const stamp = (to || new Date().toISOString().slice(0, 10));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="RR_Bid_Report_${stamp}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[reports] excel error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

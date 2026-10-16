'use strict';
// QuickBooks overhead check for Settings > Company Wage Rates.
//
// REFERENCE ONLY. Nothing here changes company rates, rate drivers, any
// estimate or any quoted price, and nothing in quoting reads these tables.
// It is a place to keep an eye on what the books say overhead is.
//
// "Pull from QuickBooks" reads the Profit and Loss report for a date range
// (read only) and keeps every expense line as a snapshot. Someone ticks which
// accounts count as overhead once; the ticks carry over to every pull. Direct
// labor hours for the period are typed in by hand, giving overhead per hour.
// An override can replace the pulled number with one typed in.
//
// Pulls happen only when someone presses the button. There is no schedule.
const db = require('../db');
const qbo = require('./qbo');

// P&L sections that hold costs. Income and the subtotal sections are skipped.
const COST_SECTIONS = { COGS: 'Cost of Goods Sold', Expenses: 'Expenses', OtherExpenses: 'Other Expenses' };
const OVERRIDE_KEY = 'qbo_overhead_override';
const HISTORY = 12;

const round2 = n => Math.round(n * 100) / 100;
const money = v => { const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

// Walk the P&L rows and return one entry per account line under a cost section.
// Sub-accounts come through as their own lines, so nothing is counted twice.
function flatten(report) {
  const out = [];
  function walk(rows, section) {
    for (const r of (rows && rows.Row) || []) {
      const sec = section || (r.group && COST_SECTIONS[r.group] ? r.group : null);
      if (r.type === 'Data' || (r.ColData && !r.Rows)) {
        if (!sec) continue;
        const c = r.ColData || [];
        const name = c[0] && c[0].value;
        if (!name) continue;
        out.push({ id: String((c[0] && c[0].id) || 'name:' + name), name, section: sec, amount: round2(money(c[1] && c[1].value)) });
      } else if (r.Rows) {
        // A parent account with sub-accounts. Its own postings, if any, are
        // either a Data row inside or the amount on its header when it has no rows.
        walk(r.Rows, sec);
      } else if (sec && r.Header && r.Header.ColData && r.Header.ColData[0] && r.Header.ColData[0].id) {
        const h = r.Header.ColData;
        out.push({ id: String(h[0].id), name: h[0].value, section: sec, amount: round2(money(h[1] && h[1].value)) });
      }
    }
  }
  walk(report && report.Rows, null);
  // Same account twice (rare): add them together.
  const byId = new Map();
  for (const a of out) {
    const prev = byId.get(a.id);
    if (prev) prev.amount = round2(prev.amount + a.amount); else byId.set(a.id, { ...a });
  }
  return [...byId.values()];
}

function includedMap() {
  const m = new Map();
  for (const r of db.prepare('SELECT account_id, included FROM qbo_overhead_accounts').all()) m.set(r.account_id, !!r.included);
  return m;
}

function monthsBetween(start, end) {
  const days = (Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86400000 + 1;
  return Math.max(days / (365.25 / 12), 0.1);
}

// Numbers for one snapshot using today's ticks.
function summarize(row, ticks) {
  const accounts = JSON.parse(row.accounts_json || '[]');
  let total = 0;
  for (const a of accounts) if (ticks.get(a.id)) total += a.amount;
  total = round2(total);
  const months = monthsBetween(row.period_start, row.period_end);
  const hours = row.labor_hours > 0 ? row.labor_hours : null;
  return {
    id: row.id, pulled_at: row.pulled_at, pulled_by_name: row.pulled_by_name,
    period_start: row.period_start, period_end: row.period_end, basis: row.basis, sandbox: !!row.sandbox,
    months: round2(months), overhead_total: total, overhead_per_year: round2(total * 12 / months),
    labor_hours: hours, per_hour: hours ? round2(total / hours) : null, note: row.note || '',
    accounts_count: accounts.length,
  };
}

function getOverride() {
  const row = db.prepare('SELECT value FROM settings_kv WHERE key = ?').get(OVERRIDE_KEY);
  if (!row || !row.value) return null;
  try { const o = JSON.parse(row.value); return o && o.per_hour != null ? o : null; } catch { return null; }
}

function setOverride(perHour, note, user) {
  if (perHour == null || perHour === '') {
    db.prepare('DELETE FROM settings_kv WHERE key = ?').run(OVERRIDE_KEY);
    return;
  }
  const n = +perHour;
  if (!Number.isFinite(n) || n < 0 || n > 10000) {
    const err = new Error('Override must be a dollar amount per hour.'); err.status = 400; throw err;
  }
  const value = JSON.stringify({ per_hour: round2(n), note: String(note || '').slice(0, 500), by: user.name || null, at: new Date().toISOString() });
  db.prepare(`INSERT INTO settings_kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(OVERRIDE_KEY, value);
}

function view() {
  const ticks = includedMap();
  const rows = db.prepare('SELECT * FROM qbo_overhead_snapshots ORDER BY id DESC LIMIT ?').all(HISTORY);
  const history = rows.map(r => summarize(r, ticks));
  const latest = rows[0] || null;
  const accounts = latest
    ? JSON.parse(latest.accounts_json).map(a => ({ ...a, included: !!ticks.get(a.id) }))
    : [];
  const override = getOverride();
  const pulled = history[0] ? history[0].per_hour : null;
  const conn = qbo.getConnection();
  return {
    configured: qbo.isConfigured(),
    connected: !!conn,
    company_name: conn ? conn.company_name : null,
    sandbox: !qbo.isProd(),
    latest: history[0] || null,
    history,
    accounts,
    sections: COST_SECTIONS,
    override,
    // What this page would show as overhead per hour. Not used anywhere else.
    current_per_hour: override ? override.per_hour : pulled,
    current_source: override ? 'override' : (pulled != null ? 'quickbooks' : null),
  };
}

async function pull({ start, end, user }) {
  if (!isDate(start) || !isDate(end)) { const e = new Error('Pick a start and end date.'); e.status = 400; throw e; }
  if (start > end) { const e = new Error('Start date is after the end date.'); e.status = 400; throw e; }
  if (monthsBetween(start, end) > 36.5) { const e = new Error('Pick a period of three years or less.'); e.status = 400; throw e; }
  if (!qbo.isConfigured()) { const e = new Error('QuickBooks is not set up on this server.'); e.status = 409; throw e; }
  if (!qbo.getConnection()) { const e = new Error('QuickBooks is not connected. A controller needs to connect it on the QuickBooks page first.'); e.status = 409; throw e; }

  let report;
  try {
    report = await qbo.report('ProfitAndLoss', { start_date: start, end_date: end, summarize_column_by: 'Total' });
  } catch (err) {
    const e = new Error('QuickBooks would not send the Profit and Loss: ' + err.message); e.status = 502; throw e;
  }
  const accounts = flatten(report);
  const basis = (report && report.Header && report.Header.ReportBasis) || null;

  // Labor hours carry over from the last pull of the same period, so a re-pull
  // does not lose what was typed in.
  const same = db.prepare('SELECT labor_hours FROM qbo_overhead_snapshots WHERE period_start = ? AND period_end = ? ORDER BY id DESC LIMIT 1').get(start, end);

  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO qbo_overhead_snapshots
        (pulled_by, pulled_by_name, period_start, period_end, basis, sandbox, accounts_json, labor_hours)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      user.userId || null, user.name || null, start, end, basis, qbo.isProd() ? 0 : 1,
      JSON.stringify(accounts), same ? same.labor_hours : null);
    // Remember account names; new accounts start unticked.
    const up = db.prepare(`INSERT INTO qbo_overhead_accounts (account_id, account_name, included) VALUES (?, ?, 0)
      ON CONFLICT(account_id) DO UPDATE SET account_name = excluded.account_name`);
    for (const a of accounts) up.run(a.id, a.name);
  });
  tx();
}

function saveTicks(map) {
  const up = db.prepare(`INSERT INTO qbo_overhead_accounts (account_id, included, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(account_id) DO UPDATE SET included = excluded.included, updated_at = excluded.updated_at`);
  const tx = db.transaction(() => {
    for (const [id, on] of Object.entries(map)) up.run(String(id).slice(0, 80), on ? 1 : 0);
  });
  tx();
}

function updateSnapshot(id, { labor_hours, note }) {
  const row = db.prepare('SELECT id FROM qbo_overhead_snapshots WHERE id = ?').get(id);
  if (!row) { const e = new Error('That pull no longer exists.'); e.status = 404; throw e; }
  let hours = null;
  if (labor_hours != null && labor_hours !== '') {
    hours = +labor_hours;
    if (!Number.isFinite(hours) || hours < 0 || hours > 10000000) { const e = new Error('Hours must be a number.'); e.status = 400; throw e; }
  }
  db.prepare('UPDATE qbo_overhead_snapshots SET labor_hours = ?, note = ? WHERE id = ?')
    .run(hours, note == null ? null : String(note).slice(0, 500), id);
}

module.exports = { flatten, view, pull, saveTicks, updateSnapshot, setOverride, getOverride, OVERRIDE_KEY };

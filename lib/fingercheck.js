'use strict';
// Fingercheck payroll pull for Settings > Company Wage Rates.
//
// Pressing "Refresh from Fingercheck" pulls:
//   - active employees (number, name, and the labels we can group them by)
//   - each employee's current pay rate
//   - every payroll check for the last 12 months (hours, gross, employer taxes)
// and keeps the result as a snapshot. Nothing here changes company rates or any
// estimate. The page shows the numbers; a person decides whether to use them,
// then saves through the normal company rates Save.
//
// Keys come from Railway: FINGERCHECK_API_KEY and FINGERCHECK_CLIENT_SECRET.
// Fingercheck wants them as the APIKEY and ClientSecretKey headers.
//
// Privacy: Fingercheck sends SSN, birth date, address and more with every
// employee. Only the fields named in pickEmployee are ever kept.

const db = require('../db');

const BASE = () => (process.env.FINGERCHECK_BASE_URL || 'https://developer.fingercheck.com/api/').replace(/\/?$/, '/');
// Same pay groups as the rate drivers on the page, plus 'exclude' for anyone
// who should not count (owners, seasonal help).
const PAY_GROUPS = ['direct_shop', 'direct_field', 'support', 'office'];
const GROUPS = [...PAY_GROUPS, 'exclude'];
const MONTHS = 12;

function isConfigured() {
  return !!(process.env.FINGERCHECK_API_KEY && process.env.FINGERCHECK_CLIENT_SECRET);
}

async function get(path) {
  const r = await fetch(BASE() + path, {
    headers: {
      APIKEY: process.env.FINGERCHECK_API_KEY,
      ClientSecretKey: process.env.FINGERCHECK_CLIENT_SECRET,
      Accept: 'application/json'
    }
  });
  if (r.status === 401 || r.status === 403) {
    const err = new Error('Fingercheck turned down the API key. Check FINGERCHECK_API_KEY and FINGERCHECK_CLIENT_SECRET in Railway.');
    err.status = 502; throw err;
  }
  if (!r.ok) {
    const err = new Error('Fingercheck returned an error (' + r.status + ') on ' + path.split('?')[0] + '.');
    err.status = 502; throw err;
  }
  const j = await r.json();
  return Array.isArray(j) ? j : [];
}

const ymd = d => d.toISOString().slice(0, 10);
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = v => (v == null ? '' : String(v).trim());
const round = (n, p = 2) => Math.round(n * 10 ** p) / 10 ** p;

// The only employee fields we keep.
function pickEmployee(e) {
  return {
    id: e.EmployeeID,
    number: str(e.EmployeeNumber),
    name: str(e.FirstLast) || [str(e.FirstName), str(e.LastName)].filter(Boolean).join(' '),
    pay_type: str(e.PayType),
    full_or_part: str(e.FullOrPartTime),
    hire_date: str(e.RehireDate || e.HireDate).slice(0, 10),
    labels: {
      pay_group: str(e.PayGroup),
      location: str(e.Location),
      job: str(e.Job),
      position: str(e.Position),
      job_title: str(e.JobTitle),
      cost_center: str(e.CostCenter1),
      wc_code: str(e.WorkersCompCode)
    }
  };
}

const isSalary = e => /salar/i.test(e.pay_type);

// Pick one current rate per employee. Fingercheck can list several rate codes
// (regular, overtime, special jobs). Newest start date wins; among those, a
// code that looks like regular pay, otherwise the lowest one (overtime is
// always higher than regular).
function currentRates(rows) {
  const by = new Map();
  for (const r of rows) {
    const rate = num(r.Rate);
    if (rate <= 0) continue;
    const list = by.get(r.EmployeeID) || [];
    list.push({ code: str(r.RateCode), start: str(r.StartDate), rate });
    by.set(r.EmployeeID, list);
  }
  const out = new Map();
  for (const [id, list] of by) {
    const newest = list.reduce((m, x) => (x.start > m ? x.start : m), '');
    const pool = list.filter(x => x.start === newest);
    const reg = pool.find(x => /^(reg|regular|hourly|1)$/i.test(x.code));
    out.set(id, reg ? reg.rate : Math.min(...pool.map(x => x.rate)));
  }
  return out;
}

// Payroll checks for a date range, pulled a month at a time to keep each call small.
async function checksFor(start, end) {
  const all = [];
  let from = new Date(start);
  while (from <= end) {
    const to = new Date(from); to.setUTCMonth(to.getUTCMonth() + 1); to.setUTCDate(to.getUTCDate() - 1);
    const stop = to < end ? to : end;
    const rows = await get(`v1/Reports/GetAllPayrollChecksForDateRange?startDate=${ymd(from)}&endDate=${ymd(stop)}`);
    all.push(...rows);
    from = new Date(stop); from.setUTCDate(from.getUTCDate() + 1);
  }
  return all;
}

// Pull everything and save it as a new snapshot. Returns the snapshot.
async function refresh(user, now = new Date()) {
  if (!isConfigured()) {
    const err = new Error('Fingercheck is not connected yet. Add FINGERCHECK_API_KEY and FINGERCHECK_CLIENT_SECRET in Railway.');
    err.status = 400; throw err;
  }
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end); start.setUTCMonth(start.getUTCMonth() - MONTHS); start.setUTCDate(start.getUTCDate() + 1);

  const employees = (await get('v1/Employees/GetAllActiveEmployees')).map(pickEmployee).filter(e => e.number);
  const rates = currentRates(await get(`v1/Reports/GetEmployeeActiveRates?startDate=${ymd(end)}&endDate=${ymd(end)}`));
  const checks = await checksFor(start, end);

  // 12 month sums by employee, plus company-wide (includes people who left).
  const sums = new Map();
  const totals = { hours: 0, gross: 0, employer_taxes: 0, workers_comp: 0, checks: 0 };
  for (const row of checks) {
    const c = row.PayrollCheck || row;
    const id = c.EmployeeID != null ? c.EmployeeID : (row.Employee || {}).EmployeeID;
    const s = sums.get(id) || { hours: 0, gross: 0, employer_taxes: 0 };
    s.hours += num(c.TotalHours);
    s.gross += num(c.GrossAmount);
    s.employer_taxes += num(c.TotalEmployerTaxes);
    sums.set(id, s);
    totals.hours += num(c.TotalHours);
    totals.gross += num(c.GrossAmount);
    totals.employer_taxes += num(c.TotalEmployerTaxes);
    totals.workers_comp += num(c.TotalWorkersComp);
    totals.checks++;
  }
  for (const k of ['hours', 'gross', 'employer_taxes', 'workers_comp']) totals[k] = round(totals[k]);

  const list = employees.map(e => {
    const s = sums.get(e.id) || { hours: 0, gross: 0, employer_taxes: 0 };
    const { id, ...keep } = e;
    return { ...keep, rate: rates.has(id) ? rates.get(id) : null, hours_12mo: round(s.hours), gross_12mo: round(s.gross), employer_taxes_12mo: round(s.employer_taxes) };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const info = db.prepare(`INSERT INTO fingercheck_snapshots
    (pulled_by, pulled_by_name, period_start, period_end, employees_json, totals_json) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(user && user.userId || null, user && user.name || null, ymd(start), ymd(end), JSON.stringify(list), JSON.stringify(totals));
  return latestSnapshot(info.lastInsertRowid);
}

function latestSnapshot(id) {
  const row = id != null
    ? db.prepare('SELECT * FROM fingercheck_snapshots WHERE id = ?').get(id)
    : db.prepare('SELECT * FROM fingercheck_snapshots ORDER BY id DESC LIMIT 1').get();
  if (!row) return null;
  let employees = [], totals = null;
  try { employees = JSON.parse(row.employees_json) || []; } catch { employees = []; }
  try { totals = row.totals_json ? JSON.parse(row.totals_json) : null; } catch { totals = null; }
  return { id: row.id, pulled_at: row.pulled_at, pulled_by_name: row.pulled_by_name, period_start: row.period_start, period_end: row.period_end, employees, totals };
}

function groupMap() {
  const m = {};
  for (const r of db.prepare('SELECT employee_number, grp FROM fingercheck_employee_groups').all()) m[r.employee_number] = r.grp;
  return m;
}

// groups: { employeeNumber: one of GROUPS | null }.
// null or '' clears the tag.
function saveGroups(groups) {
  const up = db.prepare(`INSERT INTO fingercheck_employee_groups (employee_number, grp, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(employee_number) DO UPDATE SET grp = excluded.grp, updated_at = excluded.updated_at`);
  const del = db.prepare('DELETE FROM fingercheck_employee_groups WHERE employee_number = ?');
  db.transaction(() => {
    for (const [num, g] of Object.entries(groups || {})) {
      const key = str(num).slice(0, 40);
      if (!key) continue;
      if (g == null || g === '') del.run(key);
      else if (GROUPS.includes(g)) up.run(key, g);
    }
  })();
}

// Summary for one pay group.
// avg_wage is weighted by 12 month hours: someone working 50 hrs a week counts
// five times as much as someone working 10. Salaried people count at what they
// actually earned per hour (12 month gross / hours). Anyone with no rate and no
// hours is left out of the wage average but still counted in head count.
// If nobody in the group has hours yet, it falls back to a simple average.
// hours_per_head counts only people here the whole 12 months, so a new hire's
// short year does not drag it down.
function summarize(list, periodStart) {
  const priced = [];
  for (const e of list) {
    if (isSalary(e)) { if (e.hours_12mo > 0 && e.gross_12mo > 0) priced.push({ rate: e.gross_12mo / e.hours_12mo, hours: e.hours_12mo }); }
    else if (e.rate != null) priced.push({ rate: e.rate, hours: e.hours_12mo });
  }
  const hrs = priced.reduce((s, x) => s + x.hours, 0);
  let avg = null;
  if (hrs > 0) avg = priced.reduce((s, x) => s + x.rate * x.hours, 0) / hrs;
  else if (priced.length) avg = priced.reduce((s, x) => s + x.rate, 0) / priced.length;
  const gross = list.reduce((s, e) => s + e.gross_12mo, 0);
  const taxes = list.reduce((s, e) => s + e.employer_taxes_12mo, 0);
  const hours = list.reduce((s, e) => s + e.hours_12mo, 0);
  const fullYear = list.filter(e => e.hire_date && periodStart && e.hire_date <= periodStart);
  const perHeadPool = fullYear.length ? fullYear : list;
  return {
    headcount: list.length,
    avg_wage: avg == null ? null : round(avg),
    weighted: hrs > 0,
    hours_12mo: round(hours),
    hours_per_head: perHeadPool.length ? round(perHeadPool.reduce((s, e) => s + e.hours_12mo, 0) / perHeadPool.length, 0) : null,
    gross_12mo: round(gross),
    actual_per_hour: hours > 0 ? round(gross / hours) : null,
    employer_taxes_12mo: round(taxes),
    employer_tax_pct: gross > 0 ? round(taxes / gross, 4) : null,
    left_out: list.length - priced.length
  };
}

// What the Settings page shows. Per-employee detail only when showDetail.
function view(showDetail) {
  const snap = latestSnapshot();
  const base = { configured: isConfigured(), snapshot: null, groups: null, unassigned: 0 };
  if (!snap) return base;
  const tags = groupMap();
  const tagged = snap.employees.map(e => ({ ...e, group: tags[e.number] || null }));
  const groups = {};
  for (const g of PAY_GROUPS) groups[g] = summarize(tagged.filter(e => e.group === g), snap.period_start);
  const out = {
    ...base,
    snapshot: { id: snap.id, pulled_at: snap.pulled_at, pulled_by_name: snap.pulled_by_name, period_start: snap.period_start, period_end: snap.period_end, active_employees: snap.employees.length },
    groups,
    unassigned: tagged.filter(e => !e.group).length
  };
  if (showDetail) {
    out.employees = tagged;
    out.totals = snap.totals;
  }
  return out;
}

module.exports = { isConfigured, refresh, latestSnapshot, saveGroups, groupMap, summarize, currentRates, pickEmployee, view, GROUPS, PAY_GROUPS };

'use strict';
// Fingercheck payroll pull for Settings > Company Wage Rates.
//
// Pressing "Refresh from Fingercheck" pulls:
//   - active employees (number, name, and the labels we can group them by)
//   - each employee's current pay rate
//   - every payroll check for the last 12 months (hours only, by paid week)
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

  // Hours and paid weeks by employee. Only hours are kept: gross pay is not,
  // because pay carried over from the old payroll system lands in Fingercheck
  // as a lump with no hours, which makes any pay-per-hour figure meaningless.
  // A paid week is a distinct check date with hours on it, so a short history
  // (Fingercheck is new) still gives a true hours-per-week figure.
  const sums = new Map();
  const allWeeks = new Set();
  let totalHours = 0, checkCount = 0;
  for (const row of checks) {
    const c = row.PayrollCheck || row;
    const id = c.EmployeeID != null ? c.EmployeeID : (row.Employee || {}).EmployeeID;
    const hrs = num(c.TotalHours);
    const s = sums.get(id) || { hours: 0, weeks: new Set() };
    s.hours += hrs;
    const date = str(c.CheckDate).slice(0, 10);
    if (hrs > 0 && date) { s.weeks.add(date); allWeeks.add(date); }
    sums.set(id, s);
    totalHours += hrs; checkCount++;
  }
  const totals = { hours: round(totalHours), checks: checkCount, paid_weeks: allWeeks.size };

  const list = employees.map(e => {
    const s = sums.get(e.id) || { hours: 0, weeks: new Set() };
    const { id, ...keep } = e;
    // Salaried pay is never kept: it is not an hourly rate and nobody asked to see it.
    const rate = isSalary(e) ? null : (rates.has(id) ? rates.get(id) : null);
    return { ...keep, rate, hours: round(s.hours), weeks: s.weeks.size };
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
// avg_wage: each hourly person's current rate, weighted by the hours they
// worked, so someone on 50 hrs a week counts five times someone on 10.
// Salaried people count in head count only. If nobody has hours yet, it falls
// back to a simple average of the rates.
// hours_per_week: average per person, over the weeks each person was paid.
// hours_per_year: that times 52, a projection until a full year is on file.
function summarize(list) {
  const hourly = list.filter(e => e.rate != null);
  const hrs = hourly.reduce((s, e) => s + (e.hours || 0), 0);
  let avg = null;
  if (hrs > 0) avg = hourly.reduce((s, e) => s + e.rate * (e.hours || 0), 0) / hrs;
  else if (hourly.length) avg = hourly.reduce((s, e) => s + e.rate, 0) / hourly.length;
  const worked = list.filter(e => e.weeks > 0);
  const perWeek = worked.length ? worked.reduce((s, e) => s + e.hours / e.weeks, 0) / worked.length : null;
  return {
    headcount: list.length,
    avg_wage: avg == null ? null : round(avg),
    weighted: hrs > 0,
    hours_per_week: perWeek == null ? null : round(perWeek, 1),
    hours_per_year: perWeek == null ? null : Math.round(perWeek * 52),
    weeks_of_data: list.reduce((m, e) => Math.max(m, e.weeks || 0), 0),
    salaried: list.filter(e => isSalary(e)).length,
    no_rate: list.filter(e => !isSalary(e) && e.rate == null).length
  };
}

// The only per-employee fields the page gets: who they are, the labels used to
// group them, and hours. No one's pay: the page shows group averages only.
function employeeView(e, group) {
  return {
    number: e.number, name: e.name, labels: e.labels, pay_type: e.pay_type, group,
    has_rate: e.rate != null,
    hours_per_week: e.weeks > 0 ? round(e.hours / e.weeks, 1) : null,
    weeks: e.weeks ?? null
  };
}

// What the Settings page shows. Per-employee detail only when showDetail.
function view(showDetail) {
  const snap = latestSnapshot();
  const base = { configured: isConfigured(), snapshot: null, groups: null, unassigned: 0 };
  if (!snap) return base;
  const tags = groupMap();
  // Snapshots from before hours-per-week was tracked have no weeks. Ask for a refresh.
  const stale = snap.employees.some(e => e.weeks === undefined);
  const tagged = snap.employees.map(e => ({ ...e, group: tags[e.number] || null }));
  const groups = {};
  for (const g of PAY_GROUPS) groups[g] = stale ? summarize([]) : summarize(tagged.filter(e => e.group === g));
  const out = {
    ...base,
    snapshot: { id: snap.id, pulled_at: snap.pulled_at, pulled_by_name: snap.pulled_by_name, period_start: snap.period_start, period_end: snap.period_end, active_employees: snap.employees.length, paid_weeks: snap.totals && snap.totals.paid_weeks != null ? snap.totals.paid_weeks : null, needs_refresh: stale },
    groups,
    unassigned: tagged.filter(e => !e.group).length
  };
  if (showDetail) {
    out.employees = tagged.map(e => employeeView(e, e.group));
  }
  return out;
}

module.exports = { isConfigured, refresh, latestSnapshot, saveGroups, groupMap, summarize, currentRates, pickEmployee, view, GROUPS, PAY_GROUPS };

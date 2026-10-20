// QuickBooks overhead check, end to end against the real server.js, a throwaway
// database and a fake QuickBooks. Covers:
//
//   - only an admin or the controller can see or use it; estimators get nothing
//   - not connected: a plain message, nothing saved
//   - the P&L is read for the dates picked, and only cost lines are kept
//   - sub-accounts come through once each, income is never counted
//   - ticks carry across pulls; new accounts start unticked
//   - overhead per hour uses the hours typed in; hours carry to a re-pull of the same period
//   - the override replaces the pulled number, and clearing it goes back
//   - nothing changes company rates, the live switch or an existing estimate
//
// Run with:  node test/qbo_overhead.test.js
const os = require('os'), fsx = require('fs'), pathx = require('path'), http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');

const DATA_DIR = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'qoh-'));
process.env.DATA_DIR = DATA_DIR;
const PORT = 4681, QB_PORT = 4682;
const JWT_SECRET = 'test-secret';

const db = require('../db');
db.exec(`INSERT INTO users (id, email, name, role, active, qb_role) VALUES
  (61,'boss@x.test','Boss','superadmin',1,'none'),
  (62,'joe@x.test','Joe','estimator',1,'none'),
  (63,'tanja@x.test','Tanja','estimator',1,'controller')`);
db.exec(`INSERT INTO estimates (id, project_name, bid_number, status, created_by, confirmed, oh_rate, profit_rate, fab_mh, fab_rate, erection_mh, erection_rate)
  VALUES (401,'Old Bid','1701','Submitted',62,1,0.05,0.10,100,85,100,85)`);
db.exec(`INSERT INTO wage_rates (estimate_id, role, base_rate, fica_pct, futa_pct, suta_pct, wc_pct, gl_pct, ohp_pct, consumables_pct, fuel_pct)
  VALUES (401,'shop_worker',30,0.0765,0.006,0.012,0.07,0.11,0.10,0,0)`);
db.close();

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); } };
const tok = (id, role, name) => jwt.sign({ userId: id, email: 'x', name, role }, JWT_SECRET);
const T = { boss: tok(61, 'superadmin', 'Boss'), joe: tok(62, 'estimator', 'Joe'), tanja: tok(63, 'estimator', 'Tanja') };
const B = 'http://127.0.0.1:' + PORT, QB = 'http://127.0.0.1:' + QB_PORT;
const wait = ms => new Promise(r => setTimeout(r, ms));

async function call(who, m, p, body) {
  const h = { 'content-type': 'application/json' };
  if (who) h.authorization = 'Bearer ' + T[who];
  const r = await fetch(B + p, { method: m, headers: h, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { j = null; }
  return { status: r.status, body: j };
}

// ---- fake QuickBooks P&L, shaped like Intuit's report JSON ----
const D = (id, name, amt) => ({ type: 'Data', ColData: [{ value: name, id }, { value: String(amt) }] });
let extraAccount = false, lastQuery = null, failReport = false;
function pnl() {
  const expenseRows = [
    D('60', 'Rent', '120,000.00'),
    D('61', 'Utilities', 30000),
    { type: 'Section', Header: { ColData: [{ value: 'Insurance', id: '62' }, { value: '' }] },
      Rows: { Row: [D('62', 'Insurance', 1000), D('63', 'General Liability', 40000), D('64', 'Auto', 20000)] },
      Summary: { ColData: [{ value: 'Total Insurance' }, { value: '61000.00' }] } },
    D('65', 'Office Wages', 200000),
  ];
  if (extraAccount) expenseRows.push(D('66', 'New Software', 5000));
  return {
    Header: { ReportName: 'ProfitAndLoss', ReportBasis: 'Accrual', StartPeriod: lastQuery.start_date, EndPeriod: lastQuery.end_date },
    Rows: { Row: [
      { type: 'Section', group: 'Income', Header: { ColData: [{ value: 'Income' }, { value: '' }] }, Rows: { Row: [D('1', 'Sales', 3000000)] }, Summary: { ColData: [{ value: 'Total Income' }, { value: '3000000' }] } },
      { type: 'Section', group: 'COGS', Header: { ColData: [{ value: 'Cost of Goods Sold' }, { value: '' }] }, Rows: { Row: [D('50', 'Steel', 900000), D('51', 'Shop Wages', 700000)] }, Summary: { ColData: [{ value: 'Total COGS' }, { value: '1600000' }] } },
      { type: 'Section', group: 'GrossProfit', Summary: { ColData: [{ value: 'Gross Profit' }, { value: '1400000' }] } },
      { type: 'Section', group: 'Expenses', Header: { ColData: [{ value: 'Expenses' }, { value: '' }] }, Rows: { Row: expenseRows }, Summary: { ColData: [{ value: 'Total Expenses' }, { value: '411000' }] } },
      { type: 'Section', group: 'OtherExpenses', Header: { ColData: [{ value: 'Other Expenses' }, { value: '' }] }, Rows: { Row: [D('80', 'Interest', 32000)] }, Summary: { ColData: [{ value: 'Total Other Expenses' }, { value: '32000' }] } },
      { type: 'Section', group: 'NetIncome', Summary: { ColData: [{ value: 'Net Income' }, { value: '957000' }] } },
    ] },
  };
}
const fake = http.createServer((req, res) => {
  const u = new URL(req.url, QB);
  res.setHeader('content-type', 'application/json');
  if (u.pathname === '/v3/company/123/reports/ProfitAndLoss') {
    lastQuery = Object.fromEntries(u.searchParams);
    if (failReport) { res.statusCode = 400; return res.end(JSON.stringify({ Fault: { Error: [{ Message: 'Bad date' }] } })); }
    return res.end(JSON.stringify(pnl()));
  }
  res.statusCode = 404; res.end('{}');
});

let child;
async function start() {
  child = spawn(process.execPath, ['server.js'], {
    cwd: pathx.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR, JWT_SECRET,
      BACKUP_KEY: 'bk', FEEDBACK_KEY: 'fk', BID_REMINDERS: 'off',
      QBO_CLIENT_ID: 'cid', QBO_CLIENT_SECRET: 'csec', QBO_ENV: 'sandbox',
      QBO_REDIRECT_URI: B + '/api/qbo/callback', QBO_TOKEN_TEST_URL: QB + '/token', QBO_API_TEST_URL: QB },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 60; i++) {
    await wait(250);
    try { const r = await fetch(B + '/api/health'); if (r.ok) return; } catch {}
  }
  console.log(log);
  throw new Error('server did not start');
}

function connect() {
  const d = require('better-sqlite3')(pathx.join(DATA_DIR, fsx.readdirSync(DATA_DIR).find(f => f.endsWith('.db'))));
  d.prepare(`INSERT OR REPLACE INTO qbo_connection (id, realm_id, company_name, access_token, refresh_token, access_expires_at, refresh_expires_at, has_project_scope, connected_at)
    VALUES (1, '123', 'R&R Test Co', 'at', 'rt', '2099-01-01T00:00:00Z', '2099-01-01T00:00:00Z', 1, datetime('now'))`).run();
  d.close();
}

async function run() {
  await new Promise(r => fake.listen(QB_PORT, r));
  await start();

  const before = (await call('joe', 'GET', '/api/estimates/401/wages')).body;
  const ratesBefore = (await call('boss', 'GET', '/api/settings/wage-rates')).body;

  // ---- who ----
  let r = await call('joe', 'GET', '/api/settings/qbo-overhead');
  t('estimator gets nothing but can_edit false', r.status === 200 && JSON.stringify(r.body) === '{"can_edit":false}', r.body);
  r = await call('joe', 'POST', '/api/settings/qbo-overhead/pull', { start: '2025-10-01', end: '2026-09-30' });
  t('estimator cannot pull', r.status === 403);

  // ---- not connected ----
  r = await call('boss', 'POST', '/api/settings/qbo-overhead/pull', { start: '2025-10-01', end: '2026-09-30' });
  t('not connected gives a plain message', r.status === 409 && /not connected/i.test(r.body.error), r.body);
  r = await call('boss', 'GET', '/api/settings/qbo-overhead');
  t('nothing saved when not connected', r.body.latest === null && r.body.history.length === 0 && r.body.connected === false);

  connect();

  // ---- bad dates ----
  r = await call('boss', 'POST', '/api/settings/qbo-overhead/pull', { start: '2026-09-30', end: '2025-10-01' });
  t('start after end is refused', r.status === 400);

  // ---- pull ----
  r = await call('tanja', 'POST', '/api/settings/qbo-overhead/pull', { start: '2025-10-01', end: '2026-09-30' });
  t('controller can pull', r.status === 200, r.body);
  t('asked QuickBooks for the dates picked', lastQuery && lastQuery.start_date === '2025-10-01' && lastQuery.end_date === '2026-09-30', lastQuery);
  const ids = r.body.accounts.map(a => a.id).sort();
  t('only cost lines kept, income left out', !ids.includes('1') && ids.includes('50') && ids.includes('80'), ids);
  t('sub-accounts each come through once', ids.filter(i => i === '62').length === 1 && ids.includes('63') && ids.includes('64'), ids);
  t('amounts with commas read right', r.body.accounts.find(a => a.id === '60').amount === 120000);
  t('new accounts start unticked, total is zero', r.body.accounts.every(a => !a.included) && r.body.latest.overhead_total === 0);
  t('sections are labeled', r.body.accounts.find(a => a.id === '50').section === 'COGS' && r.body.accounts.find(a => a.id === '80').section === 'OtherExpenses');
  t('marked as sandbox and accrual', r.body.latest.sandbox === true && r.body.latest.basis === 'Accrual');
  t('who pulled is kept', r.body.latest.pulled_by_name === 'Tanja');

  // ---- ticks ----
  r = await call('boss', 'PUT', '/api/settings/qbo-overhead/accounts', { included: { 60: true, 61: true, 62: true, 63: true, 64: true, 65: true, 80: true } });
  t('ticked overhead adds up (rent, utilities, insurance, office, interest)', r.body.latest.overhead_total === 443000, r.body.latest);
  t('twelve months reads as a year', Math.abs(r.body.latest.overhead_per_year - 443000) < 1000, r.body.latest.overhead_per_year);
  t('no hours yet, no per hour', r.body.latest.per_hour === null && r.body.current_per_hour === null);

  // ---- hours ----
  r = await call('boss', 'PUT', '/api/settings/qbo-overhead/snapshots/' + r.body.latest.id, { labor_hours: 29120, note: 'books not clean yet' });
  t('overhead per hour from hours typed in', r.body.latest.per_hour === 15.21 && r.body.current_per_hour === 15.21 && r.body.current_source === 'quickbooks', r.body.latest);
  t('note is kept', r.body.latest.note === 'books not clean yet');

  // ---- re-pull keeps ticks and hours; new account unticked ----
  extraAccount = true;
  r = await call('boss', 'POST', '/api/settings/qbo-overhead/pull', { start: '2025-10-01', end: '2026-09-30' });
  t('ticks carry to the next pull', r.body.latest.overhead_total === 443000, r.body.latest);
  t('hours carry to a re-pull of the same period', r.body.latest.labor_hours === 29120);
  t('a new account starts unticked', r.body.accounts.find(a => a.id === '66').included === false);
  t('history keeps both pulls', r.body.history.length === 2);
  r = await call('boss', 'POST', '/api/settings/qbo-overhead/pull', { start: '2026-07-01', end: '2026-09-30' });
  t('a different period starts with no hours', r.body.latest.labor_hours === null && r.body.history.length === 3);

  // ---- override ----
  r = await call('boss', 'PUT', '/api/settings/qbo-overhead/override', { per_hour: 59.81, note: 'rate drivers model' });
  t('override replaces the pulled number', r.body.current_per_hour === 59.81 && r.body.current_source === 'override' && r.body.override.by === 'Boss', r.body);
  r = await call('boss', 'PUT', '/api/settings/qbo-overhead/override', { per_hour: 'abc' });
  t('a bad override is refused', r.status === 400);
  r = await call('boss', 'PUT', '/api/settings/qbo-overhead/override', { per_hour: null });
  t('clearing the override goes back to QuickBooks', r.body.override === null && r.body.current_source !== 'override');

  // ---- QuickBooks error ----
  failReport = true;
  r = await call('boss', 'POST', '/api/settings/qbo-overhead/pull', { start: '2025-10-01', end: '2026-09-30' });
  t('a QuickBooks error gives a plain message and saves nothing', r.status === 502 && /Bad date/.test(r.body.error), r.body);
  failReport = false;
  r = await call('boss', 'GET', '/api/settings/qbo-overhead');
  t('still three pulls', r.body.history.length === 3);

  // ---- nothing else moved ----
  const after = (await call('joe', 'GET', '/api/estimates/401/wages')).body;
  const ratesAfter = (await call('boss', 'GET', '/api/settings/wage-rates')).body;
  t('an existing estimate is untouched', JSON.stringify(before) === JSON.stringify(after));
  t('company rates are untouched', JSON.stringify(ratesBefore.current) === JSON.stringify(ratesAfter.current));
  t('company rates switch is untouched', ratesBefore.live === ratesAfter.live);

  // ---- test copy never writes to QuickBooks ----
  process.env.TEST_COPY = '1';
  const q = require('../lib/qbo');
  let msg = '';
  try { await q.createCustomer('Should Not Exist'); } catch (e) { msg = e.message; }
  t('test copy refuses to create a customer', /test copy/i.test(msg), msg);
  msg = '';
  try { await q.createProject({ name: 'x', customerId: '1' }); } catch (e) { msg = e.message; }
  t('test copy refuses to create a project', /test copy/i.test(msg), msg);
  delete process.env.TEST_COPY;
}

run()
  .catch(err => { fail++; console.error(err); })
  .finally(() => {
    if (child) child.kill();
    fake.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });

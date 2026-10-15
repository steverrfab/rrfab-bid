// Fingercheck pull, end to end against the real server.js, a throwaway database
// and a fake Fingercheck. Covers:
//
//   - not connected: a clear message, nothing saved
//   - only an admin or the controller can pull or set groups
//   - the right headers reach Fingercheck
//   - SSN, birth date and address are never stored
//   - one current rate per employee (regular, not overtime)
//   - shop and field averages are weighted by 12 month hours
//   - hours per week come from the weeks actually paid, so a short history works
//   - gross pay and salaries are never stored or shown; carried-over pay can't skew anything
//   - estimators see the averages but never anyone's pay
//   - a bad key gives a plain message
//   - nothing changes company rates or an existing estimate
//
// Run with:  node test/fingercheck.test.js
const os = require('os'), fsx = require('fs'), pathx = require('path'), http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');

const DATA_DIR = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'fc-'));
process.env.DATA_DIR = DATA_DIR;
const PORT = 4671, FC_PORT = 4672;
const JWT_SECRET = 'test-secret';

const db = require('../db');
db.exec(`INSERT INTO users (id, email, name, role, active, qb_role) VALUES
  (51,'boss@x.test','Boss','superadmin',1,'none'),
  (52,'joe@x.test','Joe','estimator',1,'none'),
  (53,'tanja@x.test','Tanja','estimator',1,'controller')`);
db.exec(`INSERT INTO estimates (id, project_name, bid_number, status, created_by, confirmed, oh_rate, profit_rate, fab_mh, fab_rate, erection_mh, erection_rate)
  VALUES (301,'Old Bid','1601','Submitted',52,1,0.05,0.10,100,85,100,85)`);
db.exec(`INSERT INTO wage_rates (estimate_id, role, base_rate, fica_pct, futa_pct, suta_pct, wc_pct, gl_pct, ohp_pct, consumables_pct, fuel_pct)
  VALUES (301,'shop_worker',30,0.0765,0.006,0.012,0.07,0.11,0.10,0,0)`);
db.close();

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); } };
const tok = (id, role, name) => jwt.sign({ userId: id, email: 'x', name, role }, JWT_SECRET);
const T = { boss: tok(51, 'superadmin', 'Boss'), joe: tok(52, 'estimator', 'Joe'), tanja: tok(53, 'estimator', 'Tanja') };
const B = 'http://127.0.0.1:' + PORT;
const wait = ms => new Promise(r => setTimeout(r, ms));

async function call(who, m, p, body) {
  const h = { 'content-type': 'application/json' };
  if (who) h.authorization = 'Bearer ' + T[who];
  const r = await fetch(B + p, { method: m, headers: h, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { j = null; }
  return { status: r.status, body: j };
}

// ---- fake Fingercheck ----
const EMP = (id, num, first, last, extra = {}) => ({ HireDate: '2020-01-01T00:00:00',
  EmployeeID: id, EmployeeNumber: num, FirstName: first, LastName: last, FirstLast: first + ' ' + last,
  PayType: 'Hourly', FullOrPartTime: 'Full', PayGroup: 'Weekly', Location: extra.loc || 'Shop', Job: '', Position: '',
  JobTitle: extra.title || '', CostCenter1: '', WorkersCompCode: extra.wc || '3632',
  SSN: '123-45-6789', DOB: '1980-01-01', Address1: '1 Main St', ...extra.raw
});
const EMPLOYEES = [
  EMP(1, '100', 'Mike', 'Shop'),
  EMP(2, '101', 'Joe', 'Shop', { raw: { HireDate: '2026-06-01T00:00:00' } }),
  EMP(3, '200', 'Iron', 'Field', { loc: 'Field', wc: '5040' }),
  EMP(4, '300', 'Office', 'Person', { loc: 'Office', raw: { PayType: 'Salary' } })
];
const RATES = [
  { EmployeeID: 1, RateCode: 'REG', StartDate: '2026-01-01', Rate: 30 },
  { EmployeeID: 1, RateCode: 'OT', StartDate: '2026-01-01', Rate: 45 },
  { EmployeeID: 1, RateCode: 'REG', StartDate: '2025-01-01', Rate: 27 },
  { EmployeeID: 2, RateCode: 'REG', StartDate: '2026-01-01', Rate: 20 },
  { EmployeeID: 3, RateCode: 'REG', StartDate: '2026-01-01', Rate: 35 },
  { EmployeeID: 4, RateCode: 'SAL', StartDate: '2026-01-01', Rate: 80000 }
];
// One check per employee in the first month called. Mike 2500 hrs, Joe 500 hrs.
// Pay period ends the Friday before the check; one week long unless days says otherwise.
const CHECK = (empId, hours, gross, date, days = 7) => {
  const end = new Date(Date.parse(date + 'T00:00:00Z') - 7 * 86400000);
  const begin = new Date(end.getTime() - (days - 1) * 86400000);
  return { Employee: { EmployeeID: empId, SSN: 'x' }, PayrollCheck: { EmployeeID: empId, CheckDate: date + 'T00:00:00',
    PeriodBegin: begin.toISOString().slice(0, 10) + 'T00:00:00', PeriodEnd: end.toISOString().slice(0, 10) + 'T00:00:00',
    TotalHours: hours, GrossAmount: gross, TotalEmployerTaxes: 1, TotalWorkersComp: 0 } };
};
const WEEKS = ['2026-09-18', '2026-09-25', '2026-10-02', '2026-10-09'];
let fcCalls = [], checksServed = false, badKey = false;
const fake = http.createServer((req, res) => {
  fcCalls.push({ url: req.url, key: req.headers.apikey, secret: req.headers.clientsecretkey });
  if (badKey) { res.writeHead(401); return res.end('{}'); }
  let body = [];
  if (req.url.includes('GetAllActiveEmployees')) body = EMPLOYEES;
  else if (req.url.includes('GetEmployeeActiveRates')) body = RATES;
  else if (req.url.includes('GetAllPayrollChecksForDateRange')) {
    if (!checksServed) {
      checksServed = true;
      // Fingercheck is new: four weeks of history. Mike 45 hrs/wk, Joe two weeks at
      // 20, Iron 40, the salaried office person 40. A lump of pay carried over from
      // the old system arrives as a check with no hours and must not count.
      body = [
        ...WEEKS.map(d => CHECK(1, 45, 1350, d)),
        CHECK(2, 20, 400, WEEKS[2]), CHECK(2, 20, 400, WEEKS[3]),
        // Iron's first Fingercheck check covered two weeks: 80 hrs on one check.
        CHECK(3, 80, 2800, WEEKS[1], 14), CHECK(3, 40, 1400, WEEKS[2]), CHECK(3, 40, 1400, WEEKS[3]),
        ...WEEKS.map(d => CHECK(4, 40, 2307.69, d)),
        CHECK(1, 0, 61234.56, '2026-09-11'),
        CHECK(99, 30, 600, WEEKS[0])
      ];
    }
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
});

let child;
async function start(env) {
  if (child) { child.kill(); await wait(300); }
  child = spawn(process.execPath, ['server.js'], {
    cwd: pathx.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR, JWT_SECRET, BACKUP_KEY: 'bk', FEEDBACK_KEY: 'fk', BID_REMINDERS: 'off',
      FINGERCHECK_API_KEY: '', FINGERCHECK_CLIENT_SECRET: '', ...env },
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

async function run() {
  await new Promise(r => fake.listen(FC_PORT, r));

  // ---- not connected ----
  await start({});
  let r = await call('boss', 'GET', '/api/settings/fingercheck');
  t('shows not connected when keys are missing', r.status === 200 && r.body.configured === false && r.body.snapshot === null, r.body);
  r = await call('boss', 'POST', '/api/settings/fingercheck/refresh');
  t('refresh without keys gives a plain message', r.status === 400 && /Railway/.test(r.body.error), r.body);

  // ---- connected ----
  await start({ FINGERCHECK_API_KEY: 'k1', FINGERCHECK_CLIENT_SECRET: 's1', FINGERCHECK_BASE_URL: `http://127.0.0.1:${FC_PORT}/api/` });
  const before = (await call('joe', 'GET', '/api/estimates/301/wages')).body;
  const ratesBefore = (await call('boss', 'GET', '/api/settings/wage-rates')).body;

  r = await call('joe', 'POST', '/api/settings/fingercheck/refresh');
  t('an estimator cannot pull', r.status === 403, r.status);
  t('nothing was called on Fingercheck for the estimator', fcCalls.length === 0, fcCalls.length);

  r = await call('tanja', 'POST', '/api/settings/fingercheck/refresh');
  t('the controller can pull', r.status === 200 && r.body.snapshot && r.body.snapshot.active_employees === 4, r.body);
  t('headers carry the key and secret', fcCalls.length > 0 && fcCalls.every(c => c.key === 'k1' && c.secret === 's1'), fcCalls[0]);
  const checkCalls = fcCalls.filter(c => c.url.includes('GetAllPayrollChecksForDateRange'));
  t('12 months of checks pulled a month at a time', checkCalls.length >= 12 && checkCalls.length <= 13, checkCalls.length);
  t('everyone starts unassigned', r.body.unassigned === 4, r.body.unassigned);

  const mike = r.body.employees.find(e => e.number === '100');
  const stored = JSON.parse(require('better-sqlite3')(pathx.join(DATA_DIR, 'rrbid.db'), { readonly: true })
    .prepare('SELECT employees_json FROM fingercheck_snapshots ORDER BY id DESC LIMIT 1').get().employees_json);
  t('Mike gets his current regular rate, not overtime or last year', stored.find(e => e.number === '100').rate === 30);
  t('nobody\'s pay rate is sent to the page', r.body.employees.every(e => !('rate' in e)), mike);
  t('Mike: 45 hrs a week over 4 paid weeks', mike && mike.hours_per_week === 45 && mike.weeks === 4, mike);
  const office = r.body.employees.find(e => e.number === '300');
  t('a salary is never shown', office && !JSON.stringify(r.body).includes('80000') && !JSON.stringify(r.body).includes('2307'), office);
  t('no gross pay is sent to the page', !/gross|61234|1350/.test(JSON.stringify(r.body)), Object.keys(mike || {}));

  const raw = fsx.readFileSync(pathx.join(DATA_DIR, 'rrbid.db')).toString('latin1');
  const snapRow = require('better-sqlite3')(pathx.join(DATA_DIR, 'rrbid.db'), { readonly: true })
    .prepare('SELECT employees_json, totals_json FROM fingercheck_snapshots ORDER BY id DESC LIMIT 1').get();
  t('SSN, birth date and address are never stored', !/123-45-6789|1980-01-01|Main St|SSN|DOB/.test(snapRow.employees_json + snapRow.totals_json) && !raw.includes('123-45-6789'));
  t('gross pay and salaries are never stored', !/gross|61234|80000|2307/.test(snapRow.employees_json + snapRow.totals_json), snapRow.employees_json.slice(0, 200));
  t('company totals count the paid weeks', JSON.parse(snapRow.totals_json).paid_weeks === 4, snapRow.totals_json);

  // ---- groups ----
  r = await call('joe', 'PUT', '/api/settings/fingercheck/groups', { groups: { 100: 'direct_shop' } });
  t('an estimator cannot set groups', r.status === 403, r.status);
  r = await call('boss', 'PUT', '/api/settings/fingercheck/groups', { groups: { 100: 'direct_shop', 101: 'direct_shop', 200: 'direct_field', 300: 'office', 999: 'bogus' } });
  t('admin sets groups', r.status === 200 && r.body.unassigned === 0, r.body.unassigned);
  const shop = r.body.groups.direct_shop;
  // (30*2500 + 20*500) / 3000 = 28.33
  // (30 x 180 + 20 x 40) / 220 = 28.18
  t('shop average is weighted by hours (28.18, not 25)', shop.avg_wage === 28.18 && shop.weighted, shop);
  t('shop head count is 2', shop.headcount === 2, shop);
  t('shop hours per week averages each person over the weeks they were paid (32.5)', shop.hours_per_week === 32.5, shop);
  t('shop hours per year is that times 52 (1690)', shop.hours_per_year === 1690, shop);
  t('shows how many weeks of data there are', shop.weeks_of_data === 4, shop);
  t('a two-week check counts as two weeks (40 hrs/wk, not 53)', r.body.groups.direct_field.hours_per_week === 40, r.body.groups.direct_field);
  t('field average is 35', r.body.groups.direct_field.avg_wage === 35, r.body.groups.direct_field);
  // 80,000 / 2,080 = 38.46
  t('salaried office person counts in head count and hours, not the wage average', r.body.groups.office.headcount === 1 && r.body.groups.office.avg_wage === null && r.body.groups.office.salaried === 1 && r.body.groups.office.hours_per_week === 40, r.body.groups.office);
  t('support group is empty, not broken', r.body.groups.support.headcount === 0 && r.body.groups.support.avg_wage === null, r.body.groups.support);

  // ---- privacy ----
  r = await call('joe', 'GET', '/api/settings/fingercheck');
  t('estimator sees the averages', r.status === 200 && r.body.groups.direct_shop.avg_wage === 28.18);
  t('estimator never sees anyone\'s pay', r.body.employees === undefined && r.body.totals === undefined && !JSON.stringify(r.body).includes('Mike'), Object.keys(r.body));

  // groups survive a refresh; clearing a tag works
  checksServed = false;
  await call('boss', 'POST', '/api/settings/fingercheck/refresh');
  r = await call('boss', 'PUT', '/api/settings/fingercheck/groups', { groups: { 300: null } });
  t('groups survive a refresh and a tag can be cleared', r.body.groups.direct_shop.headcount === 2 && r.body.unassigned === 1, r.body);

  // ---- bad key ----
  badKey = true;
  r = await call('boss', 'POST', '/api/settings/fingercheck/refresh');
  t('a bad key gives a plain message', r.status === 502 && /API key/.test(r.body.error), r.body);
  badKey = false;

  // ---- nothing else moved ----
  const after = (await call('joe', 'GET', '/api/estimates/301/wages')).body;
  const ratesAfter = (await call('boss', 'GET', '/api/settings/wage-rates')).body;
  t('an existing estimate is untouched', JSON.stringify(before) === JSON.stringify(after));
  t('company rates are untouched', JSON.stringify(ratesBefore.current) === JSON.stringify(ratesAfter.current));
}

run()
  .catch(err => { fail++; console.error(err); })
  .finally(() => {
    if (child) child.kill();
    fake.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });

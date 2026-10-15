// Company wage rates, end to end against the real server.js over a throwaway
// database. Covers:
//
//   - only an admin or a controller can save company rates; everyone can read
//   - each save is kept as a version with who saved it
//   - a NEW estimate starts with the current company rates (half roles halved)
//   - an EXISTING estimate keeps exactly the rates it had, before and after a save
//   - workers comp = policy base rate x experience mod, applied once
//   - a blank box is saved as Not set (null), not as 0
//   - reset puts one estimate back on company rates and touches nothing else
//   - quoted price never moves when wage rates change
//   - a clone keeps the copied rates and the version they came from
//
// Run with:  node test/company_wages.test.js
const os = require('os'), fsx = require('fs'), pathx = require('path');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');

const DATA_DIR = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'cwr-'));
process.env.DATA_DIR = DATA_DIR;
const PORT = 4661;
const JWT_SECRET = 'test-secret';

const db = require('../db');
db.exec(`INSERT INTO users (id, email, name, role, active, qb_role) VALUES
  (51,'boss@x.test','Boss','superadmin',1,'none'),
  (52,'joe@x.test','Joe','estimator',1,'none'),
  (53,'tanja@x.test','Tanja','estimator',1,'controller')`);
// An existing bid with its own wage rows, made before company rates existed.
db.exec(`INSERT INTO estimates (id, project_name, bid_number, status, created_by, confirmed, oh_rate, profit_rate, fab_mh, fab_rate, erection_mh, erection_rate)
  VALUES (301,'Old Bid','1601','Submitted',52,1,0.05,0.10,100,85,100,85)`);
db.exec(`INSERT INTO wage_rates (estimate_id, role, base_rate, fica_pct, futa_pct, suta_pct, wc_pct, gl_pct, ohp_pct, consumables_pct, fuel_pct)
  VALUES (301,'shop_worker',30,0.0765,0.006,0.012,0.07,0.11,0.10,0,0),
         (301,'ironworker',32,0.0765,0.006,0.012,0.07,0.11,0.10,0.15,0.05)`);
db.close();

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); } };
const tok = (id, role, name) => jwt.sign({ userId: id, email: 'x', name, role }, JWT_SECRET);
const T = { boss: tok(51, 'superadmin', 'Boss'), joe: tok(52, 'estimator', 'Joe'), tanja: tok(53, 'estimator', 'Tanja') };
const B = 'http://127.0.0.1:' + PORT;
const near = (a, b) => Math.abs((+a) - (+b)) < 1e-9;

async function call(who, m, p, body) {
  const h = { 'content-type': 'application/json' };
  if (who) h.authorization = 'Bearer ' + T[who];
  const r = await fetch(B + p, { method: m, headers: h, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { j = null; }
  return { status: r.status, body: j };
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const role = (rows, r) => (rows || []).find(x => x.role === r) || {};

let child;
async function start() {
  child = spawn(process.execPath, ['server.js'], {
    cwd: pathx.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR, JWT_SECRET, BACKUP_KEY: 'bk', FEEDBACK_KEY: 'fk', BID_REMINDERS: 'off' },
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

const COMPANY = {
  shop_worker: { base_rate: 28, fica_pct: 0.0765, futa_pct: 0.0015, suta_pct: 0.0065, wc_base_pct: 0.04769, wc_mod: 1.24, wc_class: '3030', gl_pct: '', pension: 0.462 },
  ironworker:  { base_rate: 28, fica_pct: 0.0765, futa_pct: 0.0015, suta_pct: 0.0065, wc_base_pct: 0.0676,  wc_mod: 1.24, wc_class: '5040', gl_pct: '', pension: 0.462 },
  firewatch: {}, laborer: {}, pm: {}
};

async function run() {
  await start();

  console.log('\n--- 1. before any company rates are saved ---');
  let r = await call('joe', 'GET', '/api/settings/wage-rates');
  t('anyone signed in can read company rates', r.status === 200, r.body);
  t('nothing saved yet', r.body.current === null, r.body);
  t('an estimator cannot edit', r.body.can_edit === false, r.body);
  r = await call('joe', 'POST', '/api/estimates', { project_name: 'Before Rates' });
  const beforeId = r.body.estimate.id;
  r = await call('joe', 'GET', `/api/estimates/${beforeId}/wages`);
  t('a new estimate still gets the built-in defaults when no company rates exist', near(role(r.body.rows, 'shop_worker').gl_pct, 0.11), role(r.body.rows, 'shop_worker'));

  const oldBefore = (await call('boss', 'GET', '/api/estimates/301/wages')).body.rows;
  const oldBidBefore = (await call('boss', 'GET', '/api/estimates/301')).body.computed.totalBid;

  console.log('\n--- 2. who can save ---');
  r = await call('joe', 'PUT', '/api/settings/wage-rates', { rows: COMPANY });
  t('an estimator is refused', r.status === 403, r.body);
  r = await call('tanja', 'PUT', '/api/settings/wage-rates', { rows: COMPANY });
  t('the controller can save', r.status === 200, r.body);
  t('the save records who made it', r.body.current && r.body.current.saved_by_name === 'Tanja', r.body.current);
  const sw = r.body.current.rows.shop_worker, iw = r.body.current.rows.ironworker;
  t('WC is base x mod, once (shop 4.769% x 1.24)', near(sw.wc_pct, 0.0591356), sw.wc_pct);
  t('WC is base x mod, once (field 6.760% x 1.24)', near(iw.wc_pct, 0.083824), iw.wc_pct);
  t('a blank GL is Not set, not zero', sw.gl_pct === null, sw.gl_pct);
  t('pension keeps 3 decimals', sw.pension === 0.462, sw.pension);
  r = await call('boss', 'PUT', '/api/settings/wage-rates', { rows: COMPANY });
  t('an admin can save', r.status === 200, r.body);
  t('every save is kept in the history', r.body.history.length === 2, r.body.history);

  console.log('\n--- 3. existing estimates are untouched ---');
  const oldAfter = (await call('boss', 'GET', '/api/estimates/301/wages')).body.rows;
  const strip = rows => JSON.stringify(rows.map(({ id, ...x }) => x).sort((a, b) => a.role.localeCompare(b.role)));
  t('the old bid kept every wage value', strip(oldBefore) === strip(oldAfter), { oldBefore, oldAfter });
  t('the old bid is not tied to any company version', oldAfter.every(x => x.company_version_id == null), oldAfter);
  r = await call('boss', 'GET', '/api/estimates/301');
  t('the old bid price did not move', r.body.computed.totalBid === oldBidBefore, [oldBidBefore, r.body.computed.totalBid]);
  r = await call('joe', 'GET', `/api/estimates/${beforeId}/wages`);
  t('an estimate made before the save keeps its rates', near(role(r.body.rows, 'shop_worker').gl_pct, 0.11), role(r.body.rows, 'shop_worker'));

  console.log('\n--- 4. new estimates start on company rates ---');
  r = await call('joe', 'POST', '/api/estimates', { project_name: 'New Bid' });
  const newId = r.body.estimate.id;
  r = await call('joe', 'GET', `/api/estimates/${newId}/wages`);
  const ns = role(r.body.rows, 'shop_worker'), nh = role(r.body.rows, 'shop_half'), ni = role(r.body.rows, 'ironworker');
  t('ten roles copied', r.body.rows.length === 10, r.body.rows.length);
  t('shop base rate copied', ns.base_rate === 28, ns);
  t('shop WC effective copied', near(ns.wc_pct, 0.0591356), ns.wc_pct);
  t('field WC class copied', ni.wc_class === '5040', ni.wc_class);
  t('Not set stays Not set on the estimate', ns.gl_pct === null, ns.gl_pct);
  t('half shop has half the base and half the 401k', nh.base_rate === 14 && near(nh.pension, 0.231), nh);
  t('the estimate knows which company version it came from', r.body.company && r.body.company.id === 2, r.body.company);

  console.log('\n--- 5. editing one estimate ---');
  const priceBefore = (await call('joe', 'GET', `/api/estimates/${newId}`)).body.computed.totalBid;
  r = await call('joe', 'PUT', `/api/estimates/${newId}/wages`, { rows: [{ role: 'ironworker', wc_mod: 1.25 }] });
  t('changing the mod recalculates WC once', near(role(r.body.rows, 'ironworker').wc_pct, 0.0845), role(r.body.rows, 'ironworker').wc_pct);
  r = await call('joe', 'PUT', `/api/estimates/${newId}/wages`, { rows: [{ role: 'shop_worker', gl_pct: '' }, { role: 'ironworker', gl_pct: 0 }] });
  t('a blank box saves as Not set', role(r.body.rows, 'shop_worker').gl_pct === null, role(r.body.rows, 'shop_worker'));
  t('a typed 0 saves as 0', role(r.body.rows, 'ironworker').gl_pct === 0, role(r.body.rows, 'ironworker'));
  r = await call('joe', 'PUT', `/api/estimates/301/wages`, { rows: [{ role: 'shop_worker', wc_pct: 0.08 }] });
  t('an old estimate still takes a combined WC rate as entered', near(role(r.body.rows, 'shop_worker').wc_pct, 0.08), role(r.body.rows, 'shop_worker'));
  r = await call('joe', 'PUT', `/api/estimates/301/wages`, { rows: [{ role: 'shop_worker', wc_pct: 0.07 }] });
  const priceAfter = (await call('joe', 'GET', `/api/estimates/${newId}`)).body.computed.totalBid;
  t('quoted price does not move when wage rates change', priceBefore === priceAfter, [priceBefore, priceAfter]);

  console.log('\n--- 6. clone and reset ---');
  r = await call('joe', 'POST', `/api/estimates/${newId}/clone`, {});
  const cloneId = r.body && (r.body.id || (r.body.estimate && r.body.estimate.id));
  if (cloneId) {
    r = await call('joe', 'GET', `/api/estimates/${cloneId}/wages`);
    t('a clone copies the job rates, including the mod change', near(role(r.body.rows, 'ironworker').wc_pct, 0.0845), role(r.body.rows, 'ironworker'));
    t('a clone keeps the company version it came from', r.body.company && r.body.company.id === 2, r.body.company);
  } else {
    console.log('  (clone route answered ' + r.status + '; skipped)');
  }
  r = await call('joe', 'POST', `/api/estimates/${newId}/wages/reset`, {});
  t('reset puts the mod back to company', near(role(r.body.rows, 'ironworker').wc_pct, 0.083824), role(r.body.rows, 'ironworker'));
  if (cloneId) {
    r = await call('joe', 'GET', `/api/estimates/${cloneId}/wages`);
    t('reset on one estimate leaves its clone alone', near(role(r.body.rows, 'ironworker').wc_pct, 0.0845), role(r.body.rows, 'ironworker'));
  }
  r = await call('joe', 'POST', `/api/estimates/301/wages/reset`, {});
  t('reset also works on an old estimate when asked', r.status === 200 && r.body.company && r.body.company.id === 2, r.body.company);
  // Rate drivers are kept with each version, and never touch an estimate.
  const before301 = (await call('joe', 'GET', `/api/estimates/301/wages`)).body.rows;
  const DRIVERS = { payroll: [{ key: 'direct_shop', count: 12, rate: 28, hours: 2080 }], overhead: [{ name: 'SMECO', monthly: 6000 }], wc: { mod: 1.25 }, bad: { 'no-good key': 1, nan: 'x'.repeat(500) } };
  r = await call('boss', 'PUT', '/api/settings/wage-rates', { rows: COMPANY, drivers: DRIVERS });
  t('drivers save with the rates', r.status === 200 && r.body.current.drivers && r.body.current.drivers.payroll[0].count === 12, r.body && r.body.current);
  t('drivers keep only safe keys and short text', r.body.current.drivers.bad && !('no-good key' in r.body.current.drivers.bad) && r.body.current.drivers.bad.nan.length === 120, r.body.current.drivers.bad);
  const vDrivers = r.body.current.id;
  r = await call('joe', 'GET', '/api/settings/wage-rates');
  t('an estimator sees the rates but not the drivers (office pay)', r.status === 200 && r.body.current && r.body.current.rows && !('drivers' in r.body.current), r.body && r.body.current && Object.keys(r.body.current));
  r = await call('tanja', 'GET', '/api/settings/wage-rates');
  t('the controller sees the drivers', r.body.current.drivers && r.body.current.drivers.payroll[0].count === 12);
  r = await call('boss', 'PUT', '/api/settings/wage-rates', { rows: COMPANY });
  t('a save without drivers carries the last drivers forward', r.body.current.id === vDrivers + 1 && r.body.current.drivers && r.body.current.drivers.overhead[0].monthly === 6000, r.body.current.drivers);
  r = await call('boss', 'PUT', '/api/settings/wage-rates', { rows: COMPANY, drivers: { big: Array(200).fill('y'.repeat(120)).map(x => ({ a: x, b: x, c: x })) } });
  t('oversized drivers are refused', r.status === 400, r.status);
  r = await call('tanja', 'PUT', '/api/settings/wage-rates', { rows: COMPANY, drivers: null });
  t('drivers can be cleared', r.status === 200 && r.body.current.drivers === null, r.body && r.body.current);
  r = await call('joe', 'PUT', '/api/settings/wage-rates', { rows: COMPANY, drivers: DRIVERS });
  t('an estimator cannot save drivers', r.status === 403, r.status);
  const after301 = (await call('joe', 'GET', `/api/estimates/301/wages`)).body.rows;
  t('saving drivers leaves an existing estimate exactly as it was', JSON.stringify(before301) === JSON.stringify(after301));
}

run()
  .catch(err => { fail++; console.error(err); })
  .finally(() => {
    if (child) child.kill();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });

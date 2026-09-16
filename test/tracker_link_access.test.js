// End to end against the real server.js, over a throwaway database, with a fake
// Project Tracker listening locally. Covers:
//   - per-user page access (defaults, custom lists, who may change them, and
//     that the API itself refuses a page the person cannot see)
//   - change orders being sent to the tracker, and the change-order feed
//   - the Project tab's tracker status lookup
//   - the tracker sign-in link carrying a landing page
//   - the shared integration-key check on every key-protected endpoint
// Run with:  node test/tracker_link_access.test.js
const os = require('os'), fsx = require('fs'), pathx = require('path');
const { spawn } = require('child_process');
const http = require('http');
const jwt = require('jsonwebtoken');

const DATA_DIR = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'linktest-'));
process.env.DATA_DIR = DATA_DIR;
const PORT = 4631, TPORT = 4632;
const JWT_SECRET = 'test-secret';
const KEY = 'tracker-key-123';

// Seed the database (running the migrations) before the server opens it.
const db = require('../db');
db.exec(`INSERT INTO users (id, email, name, role, active, tracker_role) VALUES
  (21,'boss@x.test','Boss','superadmin',1,'admin'),
  (22,'adm@x.test','Adam','admin',1,'none'),
  (23,'est@x.test','Esti','estimator',1,'pm'),
  (24,'adm2@x.test','Ada','admin',1,'none')`);
db.exec(`INSERT INTO estimates (id, project_name, job_number, bid_number, client_gc, status, created_by, is_alternate, confirmed, oh_rate, contingency_rate, profit_rate, cgl_rate, sales_tax_rate, tax_mode, price_to_win)
  VALUES (10,'Ridgeview Clinic','2201-0001','1300','Barton Malow','Won',23,0,1,0.05,0,0.10,0,0.06,'full',250000),
         (11,'Maple St Warehouse',NULL,'1301','Turner','Submitted',23,0,1,0.05,0,0.10,0,0.06,'full',NULL)`);
db.close();

// ---- fake tracker ----
const got = [];   // every change-order push the tracker received
const tracker = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    if (req.headers['x-integration-key'] !== KEY) { res.writeHead(401); return res.end('{}'); }
    if (req.url === '/api/integration/change-order') {
      got.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (req.url.startsWith('/api/integration/job-status')) {
      const job = new URL(req.url, 'http://x').searchParams.get('job_number');
      if (job !== '2201-0001') { res.writeHead(404); return res.end('{}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ found: true, job_number: job, status: 'In Fabrication', contract_sum: 262000, actual_cost: 150000, shop_hours: 312.5, shop_labor_cost: 11000 }));
    }
    res.writeHead(404); res.end('{}');
  });
});

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); } };
const tok = (id, role) => jwt.sign({ userId: id, email: 'x', name: 'x', role }, JWT_SECRET);
const T = { boss: tok(21, 'superadmin'), adm: tok(22, 'admin'), est: tok(23, 'estimator'), adm2: tok(24, 'admin') };
const B = 'http://127.0.0.1:' + PORT;
async function call(who, m, p, body, headers = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  if (who) h.authorization = 'Bearer ' + T[who];
  const r = await fetch(B + p, { method: m, headers: h, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { j = null; }
  return { status: r.status, body: j };
}
const wait = ms => new Promise(r => setTimeout(r, ms));

let child;
async function start() {
  if (!tracker.listening) await new Promise(r => tracker.listen(TPORT, r));
  child = spawn(process.execPath, ['server.js'], {
    cwd: pathx.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR, JWT_SECRET, TRACKER_KEY: KEY,
      TRACKER_API_URL: 'http://127.0.0.1:' + TPORT, BACKUP_KEY: 'bk', FEEDBACK_KEY: 'fk', BID_REMINDERS: 'off' },
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
  await start();

  console.log('\n--- 1. page access: defaults match what each role saw before ---');
  let r = await call('est', 'GET', '/api/auth/me');
  t('estimator default pages', JSON.stringify(r.body.pages) === JSON.stringify(['dashboard', 'estimates', 'calendar', 'change_orders', 'trash']), r.body.pages);
  t('/me does not leak the raw column', !('page_access' in r.body), r.body);
  r = await call('adm', 'GET', '/api/auth/me');
  t('admin sees everything', r.body.pages.length === 7, r.body.pages);
  r = await call('est', 'GET', '/api/reports/bids.json');
  t('estimator refused Reports by default', r.status === 403, r);
  r = await call('est', 'GET', '/api/estimates/tax-summary');
  t('estimator refused Tax Tracker by default', r.status === 403, r);
  r = await call('adm', 'GET', '/api/estimates/tax-summary');
  t('admin gets Tax Tracker', r.status === 200, r.status);
  r = await call('est', 'GET', '/api/estimates/deleted');
  t('estimator gets Deleted Bids by default', r.status === 200, r.status);

  console.log('\n--- 2. page access: who may change it ---');
  r = await call('adm', 'PUT', '/api/users/23', { page_access: ['estimates', 'reports', 'tax'] });
  t('admin can set an estimator\'s pages', r.status === 200, r);
  r = await call('est', 'GET', '/api/auth/me');
  t('estimator now has exactly that list', JSON.stringify(r.body.pages) === JSON.stringify(['estimates', 'reports', 'tax']), r.body.pages);
  r = await call('est', 'GET', '/api/estimates/tax-summary');
  t('granted Tax Tracker now works', r.status === 200, r.status);
  r = await call('est', 'GET', '/api/estimates/deleted');
  t('removed Deleted Bids now refused', r.status === 403, r.status);
  r = await call('est', 'POST', '/api/estimates/11/restore');
  t('restore refused too', r.status === 403, r.status);
  r = await call('est', 'GET', '/api/calendar?from=2026-01-01&to=2026-12-31');
  t('removed Bid Calendar refused', r.status === 403, r.status);
  r = await call('est', 'GET', '/api/calendar/due-soon');
  t('but due-soon reminders still work', r.status === 200, r.status);
  r = await call('est', 'GET', '/api/calendar/reminder-settings');
  t('and reminder settings still work', r.status === 200, r.status);
  r = await call('est', 'GET', '/api/change-orders');
  t('removed Change Orders refused', r.status === 403, r.status);
  r = await call('est', 'GET', '/api/estimates/10');
  t('opening one of their own bids still works', r.status === 200, r.status);

  r = await call('adm', 'PUT', '/api/users/24', { page_access: ['estimates'] });
  t('admin cannot restrict another admin', r.status === 403, r);
  r = await call('boss', 'PUT', '/api/users/24', { page_access: ['estimates'] });
  t('superadmin can restrict an admin', r.status === 200, r);
  r = await call('adm2', 'GET', '/api/estimates/tax-summary');
  t('restricted admin refused Tax Tracker', r.status === 403, r.status);
  r = await call('boss', 'PUT', '/api/users/21', { page_access: ['estimates'] });
  t('nobody edits their own access', r.status === 400, r);
  r = await call('adm', 'PUT', '/api/users/21', { page_access: ['estimates'] });
  t('superadmin cannot be restricted', r.status === 400 || r.status === 403, r);
  r = await call('boss', 'PUT', '/api/users/23', { page_access: ['estimates', 'bogus'] });
  t('unknown page rejected', r.status === 400, r);
  r = await call('boss', 'GET', '/api/users');
  const est = r.body.users.find(u => u.id === 23);
  t('users list returns the stored list', JSON.stringify(est.page_access) === JSON.stringify(['estimates', 'reports', 'tax']), est);
  t('users list offers the page catalogue', Array.isArray(r.body.pages) && r.body.pages.length === 7, r.body.pages);
  r = await call('boss', 'PUT', '/api/users/23', { page_access: null });
  t('reset to role defaults', r.status === 200, r);
  r = await call('est', 'GET', '/api/auth/me');
  t('defaults are back', r.body.pages.includes('change_orders') && !r.body.pages.includes('tax'), r.body.pages);
  r = await call('boss', 'PUT', '/api/users/24', { page_access: null });

  console.log('\n--- 3. change orders reach the tracker ---');
  r = await call('est', 'POST', '/api/change-orders', { title: 'Extra lintels', estimate_id: 10, co_number: 'CO-07' });
  t('created on the won job', r.status === 201, r);
  const coId = r.body.id;
  await call('est', 'PUT', '/api/change-orders/' + coId + '/lines', [{ description: 'Lintels', qty: 10, unit: 'ea', unit_cost: 1000 }]);
  await wait(300);
  t('a Draft is not sent on line edits', got.length === 0, got);
  r = await call('est', 'PUT', '/api/change-orders/' + coId, { status: 'Submitted' });
  await wait(300);
  let last = got[got.length - 1];
  t('Submitted is sent as Pending', last && last.status === 'Pending' && !last.removed, last);
  t('job number and typed number carried', last && last.job_number === '2201-0001' && last.co_number === 'CO-07', last);
  t('amount is the pre-tax sell (10,000 +5% +10% = 11,550)', last && last.amount === 11550, last);
  r = await call('est', 'PUT', '/api/change-orders/' + coId, { status: 'Approved' });
  await wait(300);
  last = got[got.length - 1];
  t('Approved is sent as Approved', last && last.status === 'Approved', last);

  r = await fetch(B + '/api/estimates/feed/change-orders', { headers: { 'X-Integration-Key': KEY } });
  let j = await r.json();
  t('feed lists the approved change order', r.status === 200 && j.change_orders.length === 1 && j.change_orders[0].co_id === coId, j);
  t('an unfiltered feed says it is complete', j.complete === true, j);
  r = await fetch(B + '/api/estimates/feed/change-orders?job_number=9999', { headers: { 'X-Integration-Key': KEY } });
  j = await r.json();
  t('job filter works and is marked partial', j.change_orders.length === 0 && j.complete === false, j);
  r = await fetch(B + '/api/estimates/feed/change-orders');
  t('feed refuses without the key', r.status === 401, r.status);

  console.log('\n--- 3b. estimator-priced change order sends its new price ---');
  r = await call('est', 'POST', '/api/change-orders', { title: 'Priced in the estimator', estimate_id: 10, co_number: 'CO-08', pricing_mode: 'estimator' });
  const estCo = r.body;
  t('estimator change order created', r.status === 201 && estCo.estimator_estimate_id, r.body);
  await call('est', 'PUT', '/api/change-orders/' + estCo.id, { status: 'Approved' });
  await wait(300);
  let n0 = got.filter(p => p.co_id === estCo.id).length;
  r = await call('est', 'PUT', '/api/estimates/' + estCo.estimator_estimate_id, { price_to_win: 5000 });
  t('pricing saved', r.status === 200, r.status);
  await call('est', 'PUT', '/api/estimates/' + estCo.estimator_estimate_id, { price_to_win: 6000 });
  await wait(1000);
  t('nothing sent while edits are still coming', got.filter(p => p.co_id === estCo.id).length === n0, got.filter(p => p.co_id === estCo.id));
  await wait(3000);
  const priced = got.filter(p => p.co_id === estCo.id);
  t('one update sent with the new price', priced.length === n0 + 1 && priced[priced.length - 1].amount === 6000 && priced[priced.length - 1].status === 'Approved', priced);
  n0 = got.length;
  await call('est', 'PUT', '/api/estimates/10', { notes: 'real bid edit' });
  await wait(3500);
  t('editing a real bid sends nothing', got.length === n0, got.slice(n0));
  await call('est', 'DELETE', '/api/change-orders/' + estCo.id);
  await wait(300);

  r = await call('est', 'PUT', '/api/change-orders/' + coId, { status: 'Rejected' });
  await wait(300);
  last = got[got.length - 1];
  t('Rejected is sent as removed', last && last.removed === true, last);
  await call('est', 'PUT', '/api/change-orders/' + coId, { status: 'Approved' });
  r = await call('est', 'DELETE', '/api/change-orders/' + coId);
  await wait(300);
  last = got[got.length - 1];
  t('deleting sends removed', last && last.removed === true && last.co_id === coId, last);

  r = await call('est', 'POST', '/api/change-orders', { title: 'On an open bid', estimate_id: 11, co_number: '1' });
  const openCo = r.body.id; const before = got.length;
  await call('est', 'PUT', '/api/change-orders/' + openCo, { status: 'Approved' });
  await wait(300);
  t('a change order on a bid that is not won is marked removed, never live', got.slice(before).every(p => p.removed), got.slice(before));

  console.log('\n--- 4. Project tab tracker status ---');
  r = await call('est', 'GET', '/api/estimates/10/tracker-status');
  t('won job is linked', r.body.linked === true && r.body.tracker.status === 'In Fabrication', r.body);
  t('carries the bid contract for comparison', r.body.estimate.contract_amount === 250000, r.body.estimate);
  r = await call('est', 'GET', '/api/estimates/11/tracker-status');
  t('open bid is not linked', r.body.linked === false && r.body.reason === 'not_won', r.body);
  r = await call('est', 'GET', '/api/estimates/10/tracker-status');
  t('estimator with PM tracker access sees billing', r.body.money === true && r.body.tracker.actual_cost === 150000, r.body);
  t('shop hours and labor come through', r.body.tracker.shop_hours === 312.5 && r.body.tracker.shop_labor_cost === 11000, r.body.tracker);
  t('bid shop hours included', r.body.estimate.shop_hours === 0 && 'shop_labor' in r.body.estimate, r.body.estimate);
  r = await call('adm2', 'GET', '/api/estimates/10/tracker-status');
  t('admins can read it too', r.status === 200 && r.body.money === true, r.body);
  await call('boss', 'PUT', '/api/users/23', { tracker_role: 'shop' });
  r = await call('est', 'GET', '/api/estimates/10/tracker-status');
  t('shop-level tracker access sees stage, not billing', r.body.linked && r.body.money === false && r.body.tracker.status === 'In Fabrication' && !('actual_cost' in r.body.tracker) && r.body.tracker.shop_hours === 312.5 && !('shop_labor_cost' in r.body.tracker) && !('shop_labor' in r.body.estimate), r.body);
  await call('boss', 'PUT', '/api/users/23', { tracker_role: 'pm' });

  console.log('\n--- 4b. a role change resets page access ---');
  await call('boss', 'PUT', '/api/users/24', { page_access: ['estimates', 'reports', 'tax'] });
  await call('boss', 'PUT', '/api/users/24', { role: 'estimator' });
  r = await call('boss', 'GET', '/api/users');
  let u24 = r.body.users.find(u => u.id === 24);
  t('demoted admin loses the custom list', u24.role === 'estimator' && u24.page_access === null && !u24.pages.includes('tax'), u24);
  await call('boss', 'PUT', '/api/users/24', { page_access: ['estimates'] });
  await call('boss', 'PUT', '/api/users/24', { role: 'estimator', name: 'Ada' });
  r = await call('boss', 'GET', '/api/users');
  u24 = r.body.users.find(u => u.id === 24);
  t('saving the same role keeps it', JSON.stringify(u24.page_access) === '["estimates"]', u24);
  await call('boss', 'PUT', '/api/users/24', { role: 'admin' });

  console.log('\n--- 5. tracker sign-in link ---');
  r = await call('est', 'POST', '/api/auth/tracker-sso', { next: '/?job=2201-0001' });
  t('landing page passed along', r.status === 200 && r.body.url.includes('&next=%2F%3Fjob%3D2201-0001'), r.body);
  r = await call('est', 'POST', '/api/auth/tracker-sso', { next: '//evil.example' });
  t('off-site landing dropped', r.status === 200 && !r.body.url.includes('next='), r.body);
  r = await call('est', 'POST', '/api/auth/tracker-sso', {});
  t('plain link unchanged', r.status === 200 && /\/sso\?token=[^&]+$/.test(r.body.url), r.body);

  console.log('\n--- 5b. a superadmin always has the tracker ---');
  await call('boss', 'PUT', '/api/users/21', { tracker_role: 'none' });
  r = await call('boss', 'GET', '/api/auth/me');
  t('superadmin with no level shows as tracker admin', r.body.tracker_role === 'admin', r.body.tracker_role);
  r = await call('boss', 'POST', '/api/auth/tracker-sso', {});
  t('and can open the tracker', r.status === 200 && /\/sso\?token=/.test(r.body.url), r.body);
  r = await call('adm', 'GET', '/api/auth/me');
  t('an admin with no level still has none', r.body.tracker_role === 'none', r.body.tracker_role);

  console.log('\n--- 6. shared key checks ---');
  r = await fetch(B + '/api/estimates/feed/won-jobs', { headers: { 'X-Integration-Key': 'wrong' } });
  t('won-jobs feed refuses a wrong key', r.status === 401, r.status);
  r = await fetch(B + '/api/estimates/feed/won-jobs', { headers: { 'X-Integration-Key': KEY } });
  j = await r.json();
  t('won-jobs feed works with the key', r.status === 200 && j.jobs.length === 1, j);
  r = await fetch(B + '/api/estimates/feed/sov/10', { headers: { 'X-Integration-Key': KEY } });
  t('SOV feed works with the key', r.status === 200, r.status);
  r = await fetch(B + '/api/backup/status', { headers: { 'X-Integration-Key': 'nope' } });
  t('backup refuses a wrong key', r.status === 401 || r.status === 403, r.status);
  r = await fetch(B + '/api/backup/status', { headers: { 'X-Integration-Key': 'bk' } });
  t('backup accepts its key', r.status === 200, r.status);
  r = await fetch(B + '/api/feedback/admin/pending?key=nope');
  t('feedback refuses a wrong key', r.status === 403, r.status);
  r = await fetch(B + '/api/feedback/admin/pending?key=fk');
  t('feedback accepts its key', r.status === 200, r.status);

  console.log('\n--- 7. settings survive a restart (they used to reset on every deploy) ---');
  await call('boss', 'PUT', '/api/users/23', { page_access: ['estimates', 'tax'], tracker_role: 'accounting', phone: '410-555-0100' });
  child.kill();
  await wait(500);
  await start();
  r = await call('est', 'GET', '/api/auth/me');
  t('page access kept', JSON.stringify(r.body.pages) === JSON.stringify(['estimates', 'tax']), r.body.pages);
  t('tracker access kept', r.body.tracker_role === 'accounting', r.body.tracker_role);
  t('phone kept', r.body.phone === '410-555-0100', r.body.phone);
}

run()
  .catch(e => { fail++; console.error(e); })
  .finally(() => {
    try { child && child.kill(); } catch {}
    tracker.close();
    console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nALL ${pass} CHECKS PASSED`);
    process.exit(fail ? 1 : 0);
  });

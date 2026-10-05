// End to end against the real server.js, over a throwaway database, with a fake
// QuickBooks standing in for Intuit. Covers:
//
//   - who may ask (owner of a Won bid) and who may approve (a controller)
//   - nothing reaches QuickBooks until the controller approves
//   - approve creates the GC, the project and the estimate, with the SOV lines
//   - an existing GC is matched by name instead of duplicated
//   - a failure part-way keeps what was made, and a retry carries on from there
//   - the Projects API fallback to a sub-customer
//   - the Intuit sign-in return path is public but needs a valid signed state
//   - a clone never carries the QuickBooks request across
//
// Nothing here prices or edits a bid.
//
// Run with:  node test/qbo.test.js
const os = require('os'), fsx = require('fs'), pathx = require('path'), http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');

const DATA_DIR = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'qbo-'));
process.env.DATA_DIR = DATA_DIR;
const PORT = 4651, QB_PORT = 4652;
const JWT_SECRET = 'test-secret';

const db = require('../db');
db.exec(`INSERT INTO users (id, email, name, role, active, qb_role) VALUES
  (41,'boss@x.test','Boss','superadmin',1,'none'),
  (42,'joe@x.test','Joe','estimator',1,'none'),
  (43,'ctl@x.test','Kim','estimator',1,'controller'),
  (44,'other@x.test','Other','estimator',1,'none')`);
const RATES = `oh_rate, contingency_rate, profit_rate, cgl_rate, sales_tax_rate, tax_mode`;
const R = `0.05, 0, 0.10, 0, 0.06, 'full'`;
db.exec(`INSERT INTO estimates (id, project_name, job_number, bid_number, client_gc, status, created_by, is_alternate, confirmed, ${RATES}, fab_mh, fab_rate)
  VALUES (201,'Ridgeview Clinic','2301','1501','Scott Long','Won',42,0,1,${R},100,50),
         (202,'Maple Warehouse','2302','1502','Harkins','Won',42,0,1,${R},40,50),
         (203,'Still Bidding','','1503','Harkins','Submitted',42,0,1,${R},10,50),
         (204,'Not Joes Bid','2304','1504','Harkins','Won',44,0,1,${R},10,50),
         (205,'Wrong GC Job','2305','1505','Harkins','Won',42,0,1,${R},10,50)`);
db.exec(`INSERT INTO sov_items (estimate_id, item_no, description, scheduled_value, position) VALUES
  (201,'0','Scope of Work: structural steel',0,0),
  (201,'1','Shop drawings',2500,1),
  (201,'2','Fabrication',40000,2),
  (201,'3','Erection',17500,3),
  (201,'ALT-1','Canopy',6000,4),
  (202,'1','Misc metals',12000,0)`);
db.close();

// ---- fake QuickBooks ----
const qb = { customers: [{ Id: '9', DisplayName: 'Harkins' }], projects: [], estimates: [], calls: [], failEstimateOnce: false, nextId: 100 };
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => { raw += d; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    qb.calls.push(req.method + ' ' + url.pathname);
    if (url.pathname === '/token') {
      const f = new URLSearchParams(raw);
      return send(200, { access_token: 'acc-' + f.get('grant_type'), refresh_token: 'ref-' + Date.now(), expires_in: 3600,
        x_refresh_token_expires_in: 8640000, scope: qb.scope });
    }
    if (url.pathname === '/graphql') {
      const body = JSON.parse(raw);
      const id = String(qb.nextId++);
      qb.projects.push({ id, name: body.variables.name, customer: body.variables.customer.id });
      return send(200, { data: { projectManagementCreateProject: { id, name: body.variables.name } } });
    }
    const m = url.pathname.match(/^\/v3\/company\/([^/]+)\/(\w+)(?:\/(.*))?$/);
    if (!m) return send(404, {});
    const entity = m[2];
    if (entity === 'companyinfo') return send(200, { CompanyInfo: { CompanyName: 'R&R Sandbox Co' } });
    if (entity === 'query') {
      const sql = url.searchParams.get('query');
      if (/FROM Customer/.test(sql)) {
        const eq = sql.match(/DisplayName = '(.*)'/);
        const list = eq ? qb.customers.filter(c => c.DisplayName === eq[1]) : qb.customers;
        return send(200, { QueryResponse: { Customer: list } });
      }
      if (/FROM Item/.test(sql)) return send(200, { QueryResponse: { Item: [{ Id: '7', Name: 'Steel Fabrication', Type: 'Service' }, { Id: '8', Name: 'Bolts', Type: 'Inventory' }] } });
    }
    if (entity === 'customer' && req.method === 'POST') {
      const b = JSON.parse(raw);
      const c = { Id: String(qb.nextId++), DisplayName: b.DisplayName, Job: !!b.Job, ParentRef: b.ParentRef };
      qb.customers.push(c);
      return send(200, { Customer: c });
    }
    if (entity === 'estimate' && req.method === 'POST') {
      if (qb.failEstimateOnce) { qb.failEstimateOnce = false; return send(500, { Fault: { Error: [{ Message: 'Service down' }] } }); }
      const b = JSON.parse(raw);
      const total = b.Line.reduce((a, l) => a + (l.Amount || 0), 0);
      const e = { Id: String(qb.nextId++), DocNumber: '1001', TotalAmt: total, ...b };
      qb.estimates.push(e);
      return send(200, { Estimate: e });
    }
    send(404, {});
  });
});

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); } };
const tok = (id, role) => jwt.sign({ userId: id, email: 'x', name: 'x', role }, JWT_SECRET);
const T = { boss: tok(41, 'superadmin'), joe: tok(42, 'estimator'), kim: tok(43, 'estimator'), other: tok(44, 'estimator') };
const B = 'http://127.0.0.1:' + PORT;
const QB = 'http://127.0.0.1:' + QB_PORT;

async function call(who, m, p, body) {
  const h = { 'content-type': 'application/json' };
  if (who) h.authorization = 'Bearer ' + T[who];
  const r = await fetch(B + p, { method: m, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  let j = null; try { j = await r.json(); } catch { j = null; }
  return { status: r.status, body: j, location: r.headers.get('location') };
}
const wait = ms => new Promise(r => setTimeout(r, ms));

let child;
async function start() {
  child = spawn(process.execPath, ['server.js'], {
    cwd: pathx.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR, JWT_SECRET,
      BACKUP_KEY: 'bk', FEEDBACK_KEY: 'fk', BID_REMINDERS: 'off',
      QBO_CLIENT_ID: 'cid', QBO_CLIENT_SECRET: 'csec', QBO_ENV: 'sandbox',
      QBO_REDIRECT_URI: B + '/api/qbo/callback', QBO_APP_RETURN_URL: 'https://bid.example/#/quickbooks',
      QBO_TOKEN_TEST_URL: QB + '/token', QBO_API_TEST_URL: QB, QBO_GRAPHQL_TEST_URL: QB + '/graphql' },
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

async function connectAs(userId, scope) {
  qb.scope = scope;
  const state = jwt.sign({ purpose: 'qbo-connect', userId }, JWT_SECRET, { expiresIn: '15m' });
  return call(null, 'GET', `/api/qbo/callback?code=abc&realmId=555&state=${encodeURIComponent(state)}`);
}

async function run() {
  await new Promise(r => fake.listen(QB_PORT, '127.0.0.1', r));
  await start();

  console.log('\n--- 1. who may do what ---');
  let r = await call('joe', 'GET', '/api/qbo/status');
  t('anyone can ask whether QuickBooks is set up', r.status === 200 && r.body.is_controller === false, r.body);
  r = await call('kim', 'GET', '/api/qbo/status');
  t('a controller is told so', r.body.is_controller === true, r.body);
  r = await call('boss', 'GET', '/api/qbo/status');
  t('a superadmin always counts as controller', r.body.is_controller === true, r.body);
  r = await call('joe', 'GET', '/api/qbo/requests');
  t('an estimator cannot open the queue', r.status === 403, r.status);
  r = await call('joe', 'GET', '/api/qbo/connect');
  t('an estimator cannot connect QuickBooks', r.status === 403, r.status);
  r = await call('joe', 'GET', '/api/auth/me');
  t('the logged-in user carries qb_role', r.body.qb_role === 'none', r.body.qb_role);

  console.log('\n--- 2. connecting ---');
  r = await call('kim', 'GET', '/api/qbo/connect');
  t('a controller gets the Intuit sign-in page', r.status === 200 && /appcenter\.intuit\.com/.test(r.body.url) && /project-management\.project/.test(r.body.url), r.body);
  r = await call(null, 'GET', '/api/qbo/callback?code=abc&realmId=555&state=forged');
  t('a forged return is refused', r.status === 302 && /qbo=expired/.test(r.location), r.location);
  r = await connectAs(43, 'com.intuit.quickbooks.accounting project-management.project');
  t('a real return connects and sends the browser back', r.status === 302 && /qbo=connected/.test(r.location), r.location);
  r = await call('kim', 'GET', '/api/qbo/status');
  t('connected, with the company name', r.body.connected && r.body.company_name === 'R&R Sandbox Co', r.body);
  t('the Projects API was granted', r.body.has_project_scope === true, r.body);

  console.log('\n--- 3. asking ---');
  r = await call('joe', 'POST', '/api/estimates/203/qbo', {});
  t('a bid that is not Won cannot be sent', r.status === 400, r.body);
  r = await call('joe', 'POST', '/api/estimates/204/qbo', {});
  t('an estimator cannot send someone else\'s bid', r.status === 403, r.status);
  const callsBefore = qb.calls.length;
  r = await call('joe', 'POST', '/api/estimates/201/qbo', { note: 'Signed contract in hand' });
  t('Joe sends his Won bid', r.status === 200 && r.body.request.status === 'pending', r.body);
  t('nothing was written to QuickBooks', qb.calls.length === callsBefore, qb.calls.slice(callsBefore));
  r = await call('joe', 'POST', '/api/estimates/201/qbo', {});
  t('it cannot be sent twice', r.status === 409, r.body);
  r = await call('joe', 'GET', '/api/estimates/201/qbo');
  t('the bid shows it is waiting', r.body.request && r.body.request.status === 'pending', r.body);

  console.log('\n--- 4. reviewing ---');
  r = await call('kim', 'GET', '/api/qbo/requests');
  const req1 = r.body.requests.find(x => x.estimate_id === 201);
  t('it is in the controller\'s queue', !!req1 && req1.request_note === 'Signed contract in hand', r.body);
  r = await call('kim', 'GET', `/api/qbo/requests/${req1.id}/preview`);
  t('the project is named job number + project', r.body.project_name === '2301 Ridgeview Clinic', r.body.project_name);
  t('no QuickBooks customer is called Scott Long yet', r.body.customer_match === null, r.body.customer_match);
  t('four lines: the scope note and three priced', r.body.lines.length === 4, r.body.lines);
  t('the alternate is left out', !r.body.lines.some(l => /Canopy/.test(l.description)), r.body.lines);
  t('the total is the contract', r.body.total === 60000, r.body.total);
  r = await call('kim', 'POST', `/api/qbo/requests/${req1.id}/approve`, {});
  t('approving needs the product/service picked first', r.status === 400 && /product\/service/.test(r.body.error), r.body);
  r = await call('kim', 'GET', '/api/qbo/items');
  t('only service and non-inventory items are offered', r.body.items.length === 1 && r.body.items[0].name === 'Steel Fabrication', r.body);
  r = await call('kim', 'PUT', '/api/qbo/item', { item_id: '7', item_name: 'Steel Fabrication' });
  t('the controller picks it', r.status === 200, r.body);

  console.log('\n--- 5. approving, with a failure part-way ---');
  qb.failEstimateOnce = true;
  r = await call('kim', 'POST', `/api/qbo/requests/${req1.id}/approve`, {});
  t('a QuickBooks outage is reported, not swallowed', r.status === 502 && /Service down/.test(r.body.error), r.body);
  t('it is marked failed', r.body.request.status === 'failed', r.body.request);
  t('the GC it made is remembered', !!r.body.request.qb_customer_id, r.body.request);
  t('the project it made is remembered', !!r.body.request.qb_project_id && r.body.request.qb_project_kind === 'project', r.body.request);
  const custCount = qb.customers.length, projCount = qb.projects.length;
  r = await call('kim', 'POST', `/api/qbo/requests/${req1.id}/approve`, {});
  t('the retry goes through', r.status === 200 && r.body.request.status === 'sent', r.body);
  t('no second GC was made', qb.customers.length === custCount, qb.customers);
  t('no second project was made', qb.projects.length === projCount, qb.projects);
  const est = qb.estimates[qb.estimates.length - 1];
  t('the estimate is on the project', est.ProjectRef && est.ProjectRef.value === r.body.request.qb_project_id, est);
  t('the estimate is for the GC', est.CustomerRef.value === r.body.request.qb_customer_id, est);
  t('the priced lines use the chosen item', est.Line.filter(l => l.DetailType === 'SalesItemLineDetail').every(l => l.SalesItemLineDetail.ItemRef.value === '7'), est.Line);
  t('the scope line rides along as text only', est.Line[0].DetailType === 'DescriptionOnly', est.Line[0]);
  t('the estimate totals the contract', est.TotalAmt === 60000, est.TotalAmt);
  t('there is a link to it in QuickBooks', /txnId=/.test(r.body.request.qb_estimate_url || ''), r.body.request);
  r = await call('kim', 'POST', `/api/qbo/requests/${req1.id}/approve`, {});
  t('it cannot be approved twice', r.status === 409, r.body);
  r = await call('joe', 'POST', '/api/estimates/201/qbo', {});
  t('and Joe cannot send it again', r.status === 409 && /already in QuickBooks/.test(r.body.error), r.body);

  console.log('\n--- 6. an existing GC, and the sub-customer fallback ---');
  r = await connectAs(43, 'com.intuit.quickbooks.accounting');
  r = await call('kim', 'GET', '/api/qbo/status');
  t('reconnecting without the Projects API is noticed', r.body.has_project_scope === false, r.body);
  t('the product/service choice survives reconnecting', r.body.item_id === '7', r.body);
  r = await call('joe', 'POST', '/api/estimates/202/qbo', {});
  const req2 = r.body.request;
  r = await call('kim', 'GET', `/api/qbo/requests/${req2.id}/preview`);
  t('Harkins is matched to the GC already in QuickBooks', r.body.customer_match && r.body.customer_match.id === '9', r.body.customer_match);
  const before = qb.customers.filter(c => !c.Job).length;
  r = await call('kim', 'POST', `/api/qbo/requests/${req2.id}/approve`, {});
  t('approved', r.status === 200, r.body);
  t('no duplicate GC', qb.customers.filter(c => !c.Job).length === before, qb.customers);
  const sub = qb.customers.find(c => c.Id === r.body.request.qb_project_id);
  t('the job became a sub-customer under Harkins', sub && sub.Job && sub.ParentRef.value === '9', sub);
  t('marked as a sub-customer', r.body.request.qb_project_kind === 'sub_customer', r.body.request);
  const est2 = qb.estimates[qb.estimates.length - 1];
  t('its estimate is on the sub-customer', est2.CustomerRef.value === sub.Id && !est2.ProjectRef, est2);

  console.log('\n--- 7. sending back ---');
  r = await call('joe', 'POST', '/api/estimates/205/qbo', {});
  const req3 = r.body && r.body.request;
  if (req3) {
    r = await call('kim', 'POST', `/api/qbo/requests/${req3.id}/reject`, { note: 'Wrong GC' });
    t('the controller sends it back with a note', r.status === 200 && r.body.request.status === 'rejected' && r.body.request.review_note === 'Wrong GC', r.body);
    r = await call('joe', 'POST', '/api/estimates/205/qbo', {});
    t('Joe can send it again after a rejection', r.status === 200, r.body);
  } else {
    t('a bid marked Won can be sent', false, r.body);
  }

  console.log('\n--- 8. clones and access ---');
  r = await call('boss', 'POST', '/api/estimates/201/clone', {});
  const cloneId = r.body && (r.body.id || (r.body.estimate && r.body.estimate.id));
  if (cloneId) {
    r = await call('boss', 'GET', `/api/estimates/${cloneId}/qbo`);
    t('a clone does not carry the QuickBooks request', r.body.request === null, r.body);
  } else {
    console.log('  (clone route answered ' + r.status + '; skipped)');
  }
  r = await call('boss', 'PUT', '/api/users/42', { qb_role: 'controller' });
  t('an admin can make someone a controller', r.status === 200, r.body);
  r = await call('boss', 'PUT', '/api/users/42', { qb_role: 'owner' });
  t('a made-up level is refused', r.status === 400, r.body);
  r = await call('kim', 'POST', '/api/qbo/disconnect', {});
  r = await call('kim', 'GET', '/api/qbo/status');
  t('disconnecting removes the connection', r.body.connected === false, r.body);
}

run()
  .catch(err => { fail++; console.error(err); })
  .finally(() => {
    if (child) child.kill();
    fake.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });

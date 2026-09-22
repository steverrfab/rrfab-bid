// End to end against the real server.js, over a throwaway database, with no CRM
// listening at all for most of it. Covers the CRM side of the bid tool:
//
//   - the unlinked queue: which bids count, how spellings of one name are grouped,
//     and the order the CRM gets them in
//   - linking and unlinking a name, including that it never overwrites a link
//     somebody already made and that running it twice changes nothing
//   - the bid history feed picking up a link the moment it is made
//   - the shared-key guard on every /api/integration route
//   - single sign-on in from the CRM: the happy path and every way it can be refused
//   - the CRM button minting a link without CRM_APP_URL set, which is how it is on
//     Railway and why it answered 503 for everyone before
//
// Nothing here prices or edits a bid. crm_company_id and crm_company_name are labels.
//
// Run with:  node test/crm_links.test.js
const os = require('os'), fsx = require('fs'), pathx = require('path');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');

const DATA_DIR = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'crmlinks-'));
process.env.DATA_DIR = DATA_DIR;
const PORT = 4641;
const JWT_SECRET = 'test-secret';
const CRM_KEY = 'crm-key-abc';

const db = require('../db');
db.exec(`INSERT INTO users (id, email, name, role, active, crm_role) VALUES
  (31,'boss@x.test','Boss','superadmin',1,'none'),
  (32,'joe@x.test','Joe','admin',1,'user'),
  (33,'off@x.test','Offy','estimator',0,'user')`);

// Two spellings of one GC, a second GC, one bid already linked by hand, and three that
// must never show up in the queue: an alternate, a change order and a deleted bid.
const RATES = `oh_rate, contingency_rate, profit_rate, cgl_rate, sales_tax_rate, tax_mode`;
const R = `0.05, 0, 0.10, 0, 0.06, 'full'`;
db.exec(`INSERT INTO estimates (id, project_name, bid_number, client_gc, status, created_by, is_alternate, confirmed, ${RATES}, fab_mh, fab_rate)
  VALUES (101,'Ridgeview Clinic','1401','Scott Long','Won',32,0,1,${R},100,50),
         (102,'Maple Warehouse','1402','Scott long','Submitted',32,0,1,${R},40,50),
         (103,'Bay Bridge Shed','1403','scott  long,','Quoting',32,0,1,${R},10,50),
         (104,'Clinic Annex','1404','Harkins','Submitted',32,0,1,${R},5,50)`);
db.exec(`INSERT INTO estimates (id, project_name, bid_number, client_gc, status, created_by, is_alternate, confirmed, crm_company_id, crm_company_name, ${RATES})
  VALUES (105,'Already Linked','1405','Bedrock','Submitted',32,0,1,'co-bedrock','Bedrock Steel',${R})`);
db.exec(`INSERT INTO estimates (id, project_name, bid_number, client_gc, status, created_by, is_alternate, confirmed, ${RATES})
  VALUES (106,'An Alternate','1406','Ghost GC','Submitted',32,1,1,${R})`);
db.exec(`INSERT INTO estimates (id, project_name, bid_number, client_gc, status, created_by, is_alternate, confirmed, deleted_at, ${RATES})
  VALUES (107,'A Deleted Bid','1407','Gone GC','Submitted',32,0,1,datetime('now'),${R})`);
db.close();

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); } };
const tok = (id, role) => jwt.sign({ userId: id, email: 'x', name: 'x', role }, JWT_SECRET);
const T = { boss: tok(31, 'superadmin'), joe: tok(32, 'admin') };
const B = 'http://127.0.0.1:' + PORT;

async function call(who, m, p, body, headers = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  if (who) h.authorization = 'Bearer ' + T[who];
  const r = await fetch(B + p, { method: m, headers: h, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { j = null; }
  return { status: r.status, body: j };
}
// A call the way the CRM's server makes it: shared key, no bearer token.
const asCrm = (m, p, body, key = CRM_KEY) => call(null, m, p, body, { 'x-integration-key': key });
const wait = ms => new Promise(r => setTimeout(r, ms));

let child;
async function start() {
  child = spawn(process.execPath, ['server.js'], {
    cwd: pathx.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR, JWT_SECRET, CRM_KEY,
      BACKUP_KEY: 'bk', FEEDBACK_KEY: 'fk', BID_REMINDERS: 'off' },
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

const byName = (rows, n) => rows.find(r => r.name === n);

async function run() {
  await start();

  console.log('\n--- 1. the shared key is the only way in ---');
  let r = await call(null, 'GET', '/api/integration/unlinked-clients');
  t('no key is refused', r.status === 401, r);
  r = await asCrm('GET', '/api/integration/unlinked-clients', null, 'wrong-key');
  t('wrong key is refused', r.status === 401, r);
  r = await call('boss', 'GET', '/api/integration/unlinked-clients');
  t('a superadmin bearer token is not a substitute', r.status === 401, r);
  r = await asCrm('PUT', '/api/integration/link-company', { names: ['x'], crm_company_id: 'y', crm_company_name: 'z' }, 'wrong-key');
  t('the write is guarded too', r.status === 401, r);

  console.log('\n--- 2. the unlinked queue ---');
  r = await asCrm('GET', '/api/integration/unlinked-clients');
  t('the CRM gets in', r.status === 200, r.status);
  const rows = r.body.rows || [];
  t('two names waiting, not five', rows.length === 2, rows.map(x => x.name));
  const scott = byName(rows, 'Scott Long');
  t('three spellings arrive as one name', !!scott && scott.bids === 3, scott);
  t('all three spellings come back to link with', scott && scott.names.length === 3, scott && scott.names);
  t('the most-used spelling is the one shown', scott && scott.name === 'Scott Long', scott && scott.name);
  t('the spelling breakdown is there', scott && scott.spellings.length === 3, scott && scott.spellings);
  t('a won bid is counted', scott && scott.won === 1, scott && scott.won);
  t('an already linked bid is not in the queue', !byName(rows, 'Bedrock'), rows.map(x => x.name));
  t('an alternate is not a bid in the queue', !byName(rows, 'Ghost GC'), rows.map(x => x.name));
  t('a deleted bid is not either', !byName(rows, 'Gone GC'), rows.map(x => x.name));
  t('the count of waiting bids adds up', r.body.unlinked_bids === 4, r.body.unlinked_bids);
  t('the biggest name is first', rows[0].name === 'Scott Long', rows.map(x => [x.name, x.total_value]));
  t('it carries a value', scott && scott.total_value > 0, scott && scott.total_value);
  t('and sample projects', scott && scott.samples.length > 0, scott && scott.samples);

  console.log('\n--- 3. linking ---');
  r = await asCrm('PUT', '/api/integration/link-company', { names: scott.names, crm_company_id: 'co-77', crm_company_name: 'Scott Long Construction' });
  t('all three spellings link at once', r.status === 200 && r.body.updated === 3, r.body);
  r = await asCrm('GET', '/api/integration/unlinked-clients');
  t('that name has left the queue', !byName(r.body.rows, 'Scott Long'), r.body.rows.map(x => x.name));
  t('the other name is still waiting', !!byName(r.body.rows, 'Harkins'), r.body.rows.map(x => x.name));

  r = await asCrm('GET', '/api/estimates/feed/bids-for-company?crm_company_id=co-77');
  t('all three now show on that company', r.body.rows.length === 3, r.body.rows.map(x => x.id));
  t('the summary counts them', r.body.summary.bids === 3 && r.body.summary.won === 1, r.body.summary);
  t('the cached company name came across', r.body.rows.every(x => x.crm_company_name === 'Scott Long Construction'), r.body.rows[0]);

  console.log('\n--- 4. linking never reaches past what it was asked to do ---');
  r = await asCrm('PUT', '/api/integration/link-company', { names: scott.names, crm_company_id: 'co-99', crm_company_name: 'Somebody Else' });
  t('running it again changes nothing', r.body.updated === 0, r.body);
  r = await asCrm('GET', '/api/estimates/feed/bids-for-company?crm_company_id=co-77');
  t('and the first link still stands', r.body.rows.length === 3, r.body.rows.length);
  r = await asCrm('PUT', '/api/integration/link-company', { names: ['Bedrock'], crm_company_id: 'co-99', crm_company_name: 'Somebody Else' });
  t('a link made by hand is not overwritten', r.body.updated === 0, r.body);
  r = await asCrm('GET', '/api/estimates/feed/bids-for-company?crm_company_id=co-bedrock');
  t('that bid still points where it did', r.body.rows.length === 1, r.body.rows);

  console.log('\n--- 5. bad input is refused, not guessed at ---');
  r = await asCrm('PUT', '/api/integration/link-company', { names: [], crm_company_id: 'co-1', crm_company_name: 'X' });
  t('no names', r.status === 400, r);
  r = await asCrm('PUT', '/api/integration/link-company', { names: ['Harkins'], crm_company_name: 'X' });
  t('no company id', r.status === 400, r);
  r = await asCrm('PUT', '/api/integration/link-company', { names: ['Harkins'], crm_company_id: 'co-1' });
  t('no company name', r.status === 400, r);
  r = await asCrm('PUT', '/api/integration/unlink-company', { names: [] });
  t('nothing to unlink', r.status === 400, r);

  console.log('\n--- 6. undo ---');
  r = await asCrm('PUT', '/api/integration/unlink-company', { names: scott.names });
  t('unlinking puts all three back', r.body.updated === 3, r.body);
  r = await asCrm('GET', '/api/integration/unlinked-clients');
  t('and the name is back in the queue', !!byName(r.body.rows, 'Scott Long'), r.body.rows.map(x => x.name));
  r = await asCrm('GET', '/api/estimates/feed/bids-for-company?crm_company_id=co-77');
  t('the company has no bids again', r.body.rows.length === 0, r.body.rows);

  console.log('\n--- 7. the CRM button, with CRM_APP_URL unset (as on Railway) ---');
  r = await call('joe', 'POST', '/api/auth/crm-sso');
  t('it mints a link instead of answering 503', r.status === 200 && typeof r.body.url === 'string', r);
  t('it points at the CRM app', r.status === 200 && r.body.url.startsWith('https://app.rrfabrication.org/sso?token='), r.body);
  r = await call('joe', 'POST', '/api/auth/crm-sso', { next: '/companies/abc' });
  t('a landing page rides along', r.body.url.includes('next=%2Fcompanies%2Fabc'), r.body);
  r = await call('joe', 'POST', '/api/auth/crm-sso', { next: 'https://evil.test/x' });
  t('an off-site landing page is dropped', !r.body.url.includes('next='), r.body);
  r = await call('boss', 'POST', '/api/auth/crm-sso');
  t('a superadmin with no CRM access still gets nothing', r.status === 403, r);

  console.log('\n--- 8. /me hands back CRM access, so the button survives a reload ---');
  r = await call('joe', 'GET', '/api/auth/me');
  t('crm_role is there', r.body.crm_role === 'user', r.body);
  r = await call('boss', 'GET', '/api/auth/me');
  t('and is none for everyone else', r.body.crm_role === 'none', r.body);

  console.log('\n--- 9. signing in from the CRM ---');
  const mint = (payload, key = CRM_KEY, opts = { expiresIn: 120 }) =>
    jwt.sign(payload, key, { algorithm: 'HS256', ...opts });

  r = await call(null, 'POST', '/api/auth/sso-exchange', { token: mint({ email: 'joe@x.test', name: 'Joe', purpose: 'bid-sso' }) });
  t('a good link signs Joe in', r.status === 200 && !!r.body.token, r);
  t('it hands back who he is', r.body.user && r.body.user.email === 'joe@x.test' && r.body.user.role === 'admin', r.body.user);
  t('with his pages', Array.isArray(r.body.user.pages) && r.body.user.pages.length > 0, r.body.user);
  const issued = r.body.token;
  r = await call(null, 'GET', '/api/auth/me', null, { authorization: 'Bearer ' + issued });
  t('and the session it hands back really works', r.status === 200 && r.body.email === 'joe@x.test', r);

  r = await call(null, 'POST', '/api/auth/sso-exchange', { token: mint({ email: 'joe@x.test', purpose: 'crm-sso' }) });
  t('a token minted for the other direction is refused', r.status === 401, r);
  r = await call(null, 'POST', '/api/auth/sso-exchange', { token: mint({ email: 'joe@x.test', purpose: 'bid-sso' }, 'not-the-secret') });
  t('a token signed with the wrong secret is refused', r.status === 401, r);
  r = await call(null, 'POST', '/api/auth/sso-exchange', { token: mint({ email: 'joe@x.test', purpose: 'bid-sso' }, CRM_KEY, { expiresIn: -10 }) });
  t('an expired link is refused, and says so', r.status === 401 && /expired/i.test(r.body.error), r.body);
  r = await call(null, 'POST', '/api/auth/sso-exchange', { token: mint({ email: 'nobody@x.test', purpose: 'bid-sso' }) });
  t('an email with no bid tool account is refused by name', r.status === 403 && r.body.error.includes('nobody@x.test'), r.body);
  r = await call(null, 'POST', '/api/auth/sso-exchange', { token: mint({ email: 'off@x.test', purpose: 'bid-sso' }) });
  t('a deactivated account cannot be let in this way', r.status === 403, r);
  r = await call(null, 'POST', '/api/auth/sso-exchange', {});
  t('no token at all', r.status === 400, r);
  r = await call(null, 'POST', '/api/auth/sso-exchange', { token: 'not-a-jwt' });
  t('a made-up token', r.status === 401, r);

  console.log('\n--- 10. a link survives a restart ---');
  await asCrm('PUT', '/api/integration/link-company', { names: ['Harkins'], crm_company_id: 'co-hk', crm_company_name: 'Harkins Builders' });
  child.kill();
  await wait(500);
  await start();
  r = await asCrm('GET', '/api/estimates/feed/bids-for-company?crm_company_id=co-hk');
  t('still linked after a restart', r.body.rows.length === 1, r.body.rows);
}

run()
  .catch(e => { fail++; console.error(e); })
  .finally(() => {
    try { child && child.kill(); } catch {}
    console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nALL ${pass} CHECKS PASSED`);
    process.exit(fail ? 1 : 0);
  });

// Client Proposal drives bid totals, for new bids only (migration 071).
//   - an existing bid (flag 0) with a manual line and an excluded line keeps
//     exactly the old dashboard / list numbers
//   - a new bid (created through the API, flag 1) shows the proposal total:
//     manual adds in, excluded lines out, manual internal cost in profit
// Run with:  node test/proposal_drives_totals.test.js
const os = require('os'), fsx = require('fs'), pathx = require('path');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');

const DATA_DIR = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'pdt-'));
process.env.DATA_DIR = DATA_DIR;
const PORT = 4641;
const JWT_SECRET = 'test-secret';

const FIELDS = { oh_rate: 0.05, contingency_rate: 0, profit_rate: 0.10, cgl_rate: 0, sales_tax_rate: 0.06, tax_mode: 'full', fab_mh: 100, fab_rate: 50, freight: 2000, freight_qty: 1 };

const db = require('../db');
db.exec(`INSERT INTO users (id, email, name, role, active) VALUES (21,'boss@x.test','Boss','superadmin',1)`);
db.exec(`INSERT INTO estimates (id, project_name, bid_number, client_gc, status, created_by, is_alternate, confirmed, oh_rate, contingency_rate, profit_rate, cgl_rate, sales_tax_rate, tax_mode, fab_mh, fab_rate, freight, freight_qty)
  VALUES (14,'Old Job','1304','Clark','Submitted',21,0,1,0.05,0,0.10,0,0.06,'full',100,50,2000,1)`);
db.exec(`INSERT INTO proposal_manual_lines (estimate_id, position, description, amount, cost, hidden, keep_in_total) VALUES (14, 1, 'Embeds', 12000, 8000, 0, NULL)`);
db.exec(`INSERT INTO proposal_line_visibility (estimate_id, line_key, hidden, keep_in_total) VALUES (14, 'core:4', 1, 0)`);
db.close();

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); } };
const TOK = jwt.sign({ userId: 21, email: 'x', name: 'Boss', role: 'superadmin' }, JWT_SECRET);
const B = 'http://127.0.0.1:' + PORT;
async function call(m, p, body) {
  const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOK }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { j = null; }
  return { status: r.status, body: j };
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const near = (a, b) => Math.abs(a - b) < 0.01;

let child;
async function start() {
  child = spawn(process.execPath, ['server.js'], {
    cwd: pathx.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR, JWT_SECRET, BACKUP_KEY: 'bk', FEEDBACK_KEY: 'fk', BID_REMINDERS: 'off', TRACKER_API_URL: '' },
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

  console.log('\n--- existing bid: old rule, numbers unchanged ---');
  let r = await call('GET', '/api/estimates/14');
  const old = r.body;
  t('old bid flag is 0', +old.estimate.proposal_drives_totals === 0, old.estimate.proposal_drives_totals);
  const oldRevenue = old.computed.totalBid;
  const oldCost = old.proposalTotals.cost - old.proposalTotals.manualCost;
  r = await call('GET', '/api/estimates/summary');
  const oldRow = r.body.find ? r.body.find(x => x.id === 14) : (r.body.rows || []).find(x => x.id === 14);
  t('old bid revenue = estimate total (manual add and excluded line ignored)', oldRow && near(oldRow.revenue, oldRevenue), { oldRow, oldRevenue });
  t('old bid profit = total minus input cost', oldRow && near(oldRow.profit, oldRevenue - oldCost), { oldRow, oldCost });
  r = await call('GET', '/api/estimates');
  const oldList = (Array.isArray(r.body) ? r.body : r.body.rows || []).find(x => x.id === 14);
  t('old bid list amount unchanged', oldList && near(oldList.contract_amount, oldRevenue), oldList);

  console.log('\n--- new bid: proposal is the final word ---');
  r = await call('POST', '/api/estimates', { project_name: 'New Job', client_gc: 'Clark', status: 'Draft', ...FIELDS });
  const id = r.body.estimate.id;
  t('new bid flag is 1', +r.body.estimate.proposal_drives_totals === 1, r.body.estimate.proposal_drives_totals);
  const baseRevenue = r.body.computed.totalBid;
  const baseCost = r.body.proposalTotals.cost;
  t('new bid with no proposal edits matches the estimate', near(r.body.proposalTotals.revenue, baseRevenue), r.body.proposalTotals);

  r = await call('POST', `/api/estimates/${id}/proposal-lines`, { description: 'Embeds', amount: 12000 });
  const line = r.body.manualLines[0];
  t('manual add raises revenue by its price', near(r.body.proposalTotals.revenue, baseRevenue + 12000), r.body.proposalTotals);
  t('blank cost counts as $0', near(r.body.proposalTotals.cost, baseCost), r.body.proposalTotals);
  r = await call('PUT', `/api/estimates/${id}/proposal-lines/${line.id}`, { cost: 8000 });
  t('typed cost adds to cost', near(r.body.proposalTotals.cost, baseCost + 8000), r.body.proposalTotals);

  const freight = 2000 * 1.05 * 1.10;
  r = await call('PUT', `/api/estimates/${id}/proposal-lines/visibility`, { line_key: 'core:4', hidden: 1, keep_in_total: 0 });
  const pt = r.body.proposalTotals;
  t('excluded line drops out of revenue', near(pt.revenue, baseRevenue + 12000 - freight), pt);
  t('excluded line does not lower cost', near(pt.cost, baseCost + 8000), pt);

  r = await call('GET', '/api/estimates/summary');
  const row = (r.body.find ? r.body : r.body.rows || []).find(x => x.id === id);
  t('dashboard revenue = proposal total', row && near(row.revenue, pt.revenue), row);
  t('dashboard profit = proposal total minus cost incl. manual', row && near(row.profit, pt.revenue - pt.cost), row);
  r = await call('GET', '/api/estimates');
  const lr = (Array.isArray(r.body) ? r.body : r.body.rows || []).find(x => x.id === id);
  t('bid list amount = proposal total', lr && near(lr.contract_amount, pt.revenue), lr);

  r = await call('PATCH', `/api/estimates/${id}`, { price_to_win: 150000 });
  if (r.status === 404) r = await call('PUT', `/api/estimates/${id}`, { price_to_win: 150000 });
  t('price to win still wins', near(r.body.proposalTotals.revenue, 150000), r.body.proposalTotals);

  r = await call('POST', `/api/estimates/${id}/clone`, {});
  t('clone of a new bid keeps the new rule', r.body && +r.body.estimate.proposal_drives_totals === 1, r.body && r.body.estimate && r.body.estimate.proposal_drives_totals);
  r = await call('POST', `/api/estimates/14/clone`, {});
  t('clone of an old bid keeps the old rule', r.body && +r.body.estimate.proposal_drives_totals === 0, r.body && r.body.estimate && r.body.estimate.proposal_drives_totals);
}

run().catch(e => { fail++; console.error(e); }).finally(() => {
  if (child) child.kill();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});

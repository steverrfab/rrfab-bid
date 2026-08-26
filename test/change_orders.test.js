// Self-contained: spins up the change-orders router over a throwaway database
// and exercises the optional-parent behaviour end to end.
// Run with:  node test/change_orders.test.js
const os = require('os'), fsx = require('fs'), pathx = require('path');
process.env.DATA_DIR = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'cotest-'));
const express = require('express');
const db = require('../db');

// Two bids to hang change orders off, plus two users so the ownership rules
// get exercised: an admin, and an estimator who owns bid 1 but not bid 2.
db.exec("INSERT INTO users (id, email, name, role, active) VALUES (7,'a@x.test','Ann','estimator',1),(8,'b@x.test','Bo','estimator',1),(9,'c@x.test','Cy','estimator',1)");
db.exec(`INSERT INTO estimates (id, project_name, job_number, bid_number, client_gc, status, created_by, is_alternate, oh_rate, contingency_rate, profit_rate, cgl_rate, sales_tax_rate, tax_mode)
  VALUES (1,'Maple St Warehouse',NULL,'1234','Turner Construction','Submitted',7,0,0.05,0,0.12,0,0.06,'full'),
         (2,'Ridgeview Clinic','J-2201','1300','Barton Malow','Won',8,0,0.05,0.02,0.10,0.01,0.06,'full')`);

let USER = { userId: 7, role: 'estimator' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = USER; next(); });
app.use('/api/change-orders', require('../routes/change_orders'));
const srv = app.listen(4599, run);

const B = 'http://127.0.0.1:4599/api/change-orders';
const call = async (m, p, body) => {
  const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); } };

async function run() {
  console.log('\n--- 1. standalone change order, no bid at all ---');
  let r = await call('POST', '/', { title: 'Yard fence repair', reason: 'Truck backed into it', requested_by: 'Dana Reyes', scope: 'Replace 40 ft of fence', project_name: 'RR Yard', client_gc: 'Internal' });
  t('created without estimate_id', r.status === 201, r.body);
  const solo = r.body;
  t('estimate_id is null', solo.estimate_id === null, solo.estimate_id);
  t('parent_type standalone', solo.parent_type === 'standalone', solo.parent_type);
  t('label has no bid prefix', solo.label === 'CO-001', solo.label);
  t('project carried', solo.project_name === 'RR Yard' && solo.client_gc === 'Internal', solo);
  t('rates fall back to shop defaults', solo.profit_rate === 0.10 && solo.oh_rate === 0.05, solo);

  console.log('\n--- 2. standalone numbering is its own series ---');
  r = await call('POST', '/', { title: 'Second solo', reason: 'r', requested_by: 'x', scope: 's', project_name: 'Other job' });
  t('second standalone is CO-002', r.body.label === 'CO-002', r.body.label);
  const solo2 = r.body;

  console.log('\n--- 3. bid-attached still behaves exactly as before ---');
  r = await call('POST', '/', { title: 'Extra embeds', reason: 'RFI 12', requested_by: 'Pat Lin', scope: '12 embeds' , estimate_id: 1 });
  t('created with estimate_id', r.status === 201, r.body);
  const linked = r.body;
  t('label is bid-prefixed', linked.label === 'Bid 1234 CO-001', linked.label);
  t('parent_type bid', linked.parent_type === 'bid', linked.parent_type);
  t('project copied from bid', linked.project_name === 'Maple St Warehouse', linked.project_name);
  t('rates copied from bid', linked.profit_rate === 0.12, linked.profit_rate);
  t('per-bid seq unaffected by standalones', linked.seq === 1, linked.seq);

  console.log('\n--- 4. required fields ---');
  r = await call('POST', '/', { title: 'x' });
  t('still rejects an empty CO', r.status === 400, r.body);
  t('estimate_id NOT in missing list', !r.body.fields.includes('estimate_id'), r.body.fields);
  t('project_name required when unlinked', r.body.fields.includes('project_name'), r.body.fields);
  r = await call('POST', '/', { title: 'x', reason: 'r', requested_by: 'q', scope: 's', estimate_id: 1 });
  t('project_name NOT required when linked', r.status === 201, r.body);
  const linked2 = r.body;
  t('second CO on same bid is CO-002', linked2.label === 'Bid 1234 CO-002', linked2.label);

  console.log('\n--- 5. attach a standalone CO to a bid later ---');
  r = await call('PUT', '/' + solo.id, { estimate_id: 2 });
  t('estimator blocked from a bid they do not own', r.status === 403, r.body);
  USER = { userId: 1, role: 'admin' };
  r = await call('PUT', '/' + solo.id, { estimate_id: 2 });
  t('attach accepted', r.status === 200, r.body);
  t('now job-typed', r.body.parent_type === 'job', r.body.parent_type);
  t('renumbered onto the job series', r.body.label === 'J-2201 CO-001', r.body.label);
  t('project now tracks the job', r.body.project_name === 'Ridgeview Clinic', r.body.project_name);
  t('rates NOT silently re-copied', r.body.profit_rate === 0.10, r.body.profit_rate);
  t('lines/parent hydrated', r.body.parent && r.body.parent.id === 2, r.body.parent);

  console.log('\n--- 6. detach back to standalone ---');
  r = await call('PUT', '/' + solo.id, { estimate_id: null, project_name: 'RR Yard', client_gc: 'Internal' });
  t('detach accepted', r.status === 200, r.body);
  t('back to standalone', r.body.estimate_id === null && r.body.parent_type === 'standalone', r.body);
  t('typed project restored', r.body.project_name === 'RR Yard', r.body.project_name);
  t('parent is null', r.body.parent === null, r.body.parent);

  console.log('\n--- 7. a sent-out CO keeps its number when re-parented ---');
  await call('PUT', '/' + solo2.id, { status: 'Submitted' });
  const before = (await call('GET', '/' + solo2.id)).body;
  r = await call('PUT', '/' + solo2.id, { estimate_id: 1 });
  t('seq frozen once past Draft', r.body.seq === before.seq, { was: before.seq, now: r.body.seq });

  USER = { userId: 7, role: 'estimator' };
  console.log('\n--- 8. omitting estimate_id on update leaves the link alone ---');
  r = await call('PUT', '/' + linked.id, { title: 'Extra embeds, revised' });
  t('still attached to bid 1', r.body.estimate_id === 1, r.body.estimate_id);
  t('title updated', r.body.title === 'Extra embeds, revised', r.body.title);

  console.log('\n--- 9. pricing math untouched ---');
  r = await call('PUT', '/' + linked.id + '/lines', [{ description: 'Embeds', qty: 12, unit: 'ea', unit_cost: 100 }]);
  const c = r.body.computed;
  const expect = (() => { const cost=1200, oh=cost*0.05, a1=cost+oh, cont=a1*0, a2=a1+cont, prof=a2*0.12, a3=a2+prof, cgl=a3*0, sell=a3+cgl; return sell + sell*0.06; })();
  t('total matches the cascade', Math.abs(c.total - expect) < 0.001, { got: c.total, expect });

  console.log('\n--- 10. access control ---');
  USER = { userId: 9, role: 'estimator' };  // owns nothing
  r = await call('GET', '/');
  t('stranger sees no COs', r.body.length === 0, r.body.map(x => x.label));
  r = await call('POST', '/', { title: 'Mine', reason: 'r', requested_by: 'q', scope: 's', project_name: 'Side job' });
  t('stranger may create a standalone CO', r.status === 201, r.body);
  const mine = r.body;
  r = await call('GET', '/');
  t('and sees only their own', r.body.length === 1 && r.body[0].id === mine.id, r.body.map(x => x.label));
  r = await call('PUT', '/' + mine.id, { estimate_id: 1 });
  t('cannot park it on someone else bid', r.status === 403, r.body);
  r = await call('GET', '/' + linked.id);
  t('cannot read someone else CO', r.status === 403, r.body);
  USER = { userId: 1, role: 'admin' };
  r = await call('GET', '/');
  t('admin sees them all', r.body.length === 5, r.body.map(x => x.label));
  r = await call('GET', '/?estimate_id=none');
  t('?estimate_id=none filters to unattached', r.body.every(x => x.estimate_id === null) && r.body.length === 2, r.body.map(x => x.label));

  console.log('\n--- 11. delete still works on a standalone ---');
  r = await call('DELETE', '/' + mine.id);
  t('soft delete ok', r.status === 200, r.body);

  console.log('\n' + (fail ? 'FAILURES: ' + fail + ' / ' + (pass+fail) : 'ALL ' + pass + ' CHECKS PASSED'));
  srv.close();
  process.exit(fail ? 1 : 0);
}

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
// A won PROCESS-ONLY job, so a change order against one can be shown to open the
// process-only estimator rather than the full structural one.
// po_labor_rate / po_op_pct are deliberately NOT the column defaults, so the
// test can tell a copied rate from a fallback.
db.exec(`INSERT INTO estimates (id, project_name, job_number, bid_number, client_gc, status, created_by, is_alternate, job_type, oh_rate, contingency_rate, profit_rate, cgl_rate, sales_tax_rate, tax_mode, po_labor_rate, po_op_pct)
  VALUES (3,'Bricktown Shear Work','J-3300','1400','Devon Steel','Won',8,0,'process_only',0.05,0,0.10,0,0.06,'full',88,0.2)`);

let USER = { userId: 7, role: 'estimator' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = USER; next(); });
app.use('/api/change-orders', require('../routes/change_orders'));
// Mounted so the bid-lifecycle guards can be exercised against a change order's
// backing estimate: cloning, submitting or winning one of those must be refused.
app.use('/api/estimates', require('../routes/estimates').router);
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
  // Only the title is enforced by the API now. Reason, requested-by and scope
  // used to be mandatory on the way in, which meant a change order could not be
  // opened at all until every box was filled; they are filled in on the detail
  // screen instead. The job is required by the new-change-order screen, not by
  // the API, so that change orders written before that rule still save.
  r = await call('POST', '/', { title: '' });
  t('rejects a CO with no title', r.status === 400, r.body);
  t('title named as the missing field', r.body.fields.includes('title'), r.body.fields);
  t('estimate_id NOT in missing list', !r.body.fields.includes('estimate_id'), r.body.fields);

  r = await call('POST', '/', { title: 'Bare bones' });
  t('accepts a title-only CO', r.status === 201, r.body);
  t('reason left blank, not the string "undefined"', r.body.reason === '', JSON.stringify(r.body.reason));
  t('requested_by left blank', r.body.requested_by === '', JSON.stringify(r.body.requested_by));
  t('scope left blank', r.body.scope === '', JSON.stringify(r.body.scope));

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
  // 6 and 3 rather than 5 and 2: section 4 now creates a title-only standalone
  // CO to prove the API accepts one.
  t('admin sees them all', r.body.length === 6, r.body.map(x => x.label));
  r = await call('GET', '/?estimate_id=none');
  t('?estimate_id=none filters to unattached', r.body.every(x => x.estimate_id === null) && r.body.length === 3, r.body.map(x => x.label));

  console.log('\n--- 11. delete still works on a standalone ---');
  r = await call('DELETE', '/' + mine.id);
  t('soft delete ok', r.status === 200, r.body);

  console.log('\n--- 12. full-estimator change orders ---');
  USER = { userId: 1, role: 'admin' };
  const bidsBefore = db.prepare(
    'SELECT COUNT(*) AS n FROM estimates WHERE deleted_at IS NULL AND is_alternate = 0 AND change_order_id IS NULL'
  ).get().n;

  r = await call('POST', '/', { title: 'Mezzanine columns', estimate_id: 2, pricing_mode: 'estimator' });
  t('estimator CO created', r.status === 201, r.body);
  const estCO = r.body;
  t('pricing_mode stored', estCO.pricing_mode === 'estimator', estCO.pricing_mode);
  t('backing estimate id handed to the frontend', !!estCO.estimator_estimate_id, estCO.estimator_estimate_id);

  const backing = db.prepare('SELECT * FROM estimates WHERE id = ?').get(estCO.estimator_estimate_id);
  t('backing row exists', !!backing);
  t('backing row is tagged to the CO', backing.change_order_id === estCO.id, backing.change_order_id);
  t('backing row has no bid number', !backing.bid_number, backing.bid_number);
  t('rates copied from the job', backing.profit_rate === 0.10 && backing.contingency_rate === 0.02, [backing.profit_rate, backing.contingency_rate]);
  t('job type copied from the job', backing.job_type === 'full', backing.job_type);
  // Belt and braces: the counting queries filter on change_order_id IS NULL AND
  // (bid_type = 'real' OR bid_type IS NULL). This row fails both independently.
  t('backing row is never counted as a real bid', backing.bid_type === 'change_order', backing.bid_type);
  t('confirmed, so the editor is not gated', backing.confirmed === 1, backing.confirmed);

  // The whole risk of this design is a backing row showing up somewhere it is
  // not a bid. This is the guard those queries all share.
  const bidsAfter = db.prepare(
    'SELECT COUNT(*) AS n FROM estimates WHERE deleted_at IS NULL AND is_alternate = 0 AND change_order_id IS NULL'
  ).get().n;
  t('backing row does NOT count as a bid', bidsAfter === bidsBefore, [bidsBefore, bidsAfter]);

  // A backing row must never be offered as something to hang a CO on.
  r = await call('GET', '/targets');
  t('backing row is not a change-order target', !r.body.some(x => x.id === backing.id), r.body.map(x => x.id));

  // With no cost inputs on it yet the estimator total is zero, and critically it
  // comes from the estimate rather than from change_order_lines.
  r = await call('GET', '/' + estCO.id);
  t('estimator CO totals come back', r.status === 200 && !!r.body.computed, r.body);
  t('empty estimator CO totals zero', r.body.computed.total === 0, r.body.computed);

  // Put real cost on the backing estimate and the CO total must follow it.
  db.prepare('UPDATE estimates SET fab_mh = 10, fab_rate = 100 WHERE id = ?').run(backing.id);
  r = await call('GET', '/' + estCO.id);
  t('CO total tracks the backing estimate', r.body.computed.cost > 0 && r.body.computed.total > r.body.computed.cost, r.body.computed);

  // Quick COs must be completely unaffected by any of this.
  r = await call('POST', '/', { title: 'Quick one', estimate_id: 2, pricing_mode: 'quick' });
  const quickCO = r.body;
  t('quick CO has no backing estimate', quickCO.estimator_estimate_id === null, quickCO.estimator_estimate_id);
  await call('PUT', '/' + quickCO.id + '/lines', [{ description: 'x', qty: 2, unit: 'ea', unit_cost: 50 }]);
  r = await call('GET', '/' + quickCO.id);
  t('quick CO still prices off its own lines', r.body.computed.cost === 100, r.body.computed);

  console.log('\n--- 13. a change order on a process-only job ---');
  r = await call('POST', '/', { title: 'Extra shearing', estimate_id: 3, pricing_mode: 'estimator' });
  t('created against the process-only job', r.status === 201, r.body);
  const poCO = r.body;
  const poBacking = db.prepare('SELECT * FROM estimates WHERE id = ?').get(poCO.estimator_estimate_id);
  // The bug this catches: loadParent did not SELECT job_type, so every backing
  // row came out 'full' via the fallback and a process-only change order opened
  // the wrong estimator and was priced by the wrong cascade.
  t('process-only job type actually carried over', poBacking.job_type === 'process_only', poBacking.job_type);
  t('process rates carried over, not left at shop defaults', poBacking.po_labor_rate === 88 && poBacking.po_op_pct === 0.2, [poBacking.po_labor_rate, poBacking.po_op_pct]);
  const poSeeded = db.prepare('SELECT COUNT(*) AS n FROM process_only_lines WHERE estimate_id = ?').get(poBacking.id).n;
  t('process-only default lines seeded', poSeeded > 0, poSeeded);
  t('owned by the job owner, not the CO author', poBacking.created_by === 8, poBacking.created_by);

  // Priced by the PROCESS cascade. Before the fix this read bundle.computed and
  // reported zero however much was typed into the process sheet.
  db.prepare('UPDATE process_only_lines SET qty = 4, labor_hrs = 5 WHERE estimate_id = ? AND position = (SELECT MIN(position) FROM process_only_lines WHERE estimate_id = ?)').run(poBacking.id, poBacking.id);
  r = await call('GET', '/' + poCO.id);
  t('process-only CO prices off the process cascade', r.body.computed.total > 0, r.body.computed);
  t('process cascade column adds up', Math.abs((r.body.computed.cost + r.body.computed.prof + r.body.computed.roundingAdj) - r.body.computed.sell) < 0.01, r.body.computed);

  // Price to win is what the client proposal quotes, so it has to be what the
  // change order reports too.
  db.prepare('UPDATE estimates SET price_to_win = 12345 WHERE id = ?').run(backing.id);
  r = await call('GET', '/' + estCO.id);
  t('price to win drives the sell price', Math.abs(r.body.computed.sell - 12345) < 0.01, r.body.computed);
  t('and the column still adds up', Math.abs((r.body.computed.cost + r.body.computed.oh + r.body.computed.cont + r.body.computed.prof + r.body.computed.cgl + r.body.computed.roundingAdj) - r.body.computed.sell) < 0.01, r.body.computed);
  db.prepare('UPDATE estimates SET price_to_win = NULL WHERE id = ?').run(backing.id);

  console.log('\n--- 14. the backing row never becomes a bid ---');
  // Only one pricing row per change order, enforced by a unique index.
  let dupThrew = false;
  try {
    db.prepare('INSERT INTO estimates (project_name, change_order_id) VALUES (?,?)').run('sneaky', estCO.id);
  } catch (err) { dupThrew = true; }
  t('a second backing row is refused', dupThrew);

  // Switching to quick and back must find the same row, not mint another.
  await call('PUT', '/' + estCO.id, { pricing_mode: 'quick' });
  r = await call('PUT', '/' + estCO.id, { pricing_mode: 'estimator' });
  t('switching back reuses the same backing row', r.body.estimator_estimate_id === backing.id, [r.body.estimator_estimate_id, backing.id]);
  const stillOne = db.prepare('SELECT COUNT(*) AS n FROM estimates WHERE change_order_id = ?').get(estCO.id).n;
  t('still exactly one backing row', stillOne === 1, stillOne);

  console.log('\n--- 14b. the bid lifecycle is refused on a backing estimate ---');
  // These are the dangerous ones. Cloning or revising a backing row would mint a
  // real, counted bid out of a change order; submitting or winning one would
  // email the whole recipient list and push a job to the tracker.
  const E = 'http://127.0.0.1:4599/api/estimates';
  const ecall = async (m, p, body) => {
    const r = await fetch(E + p, { method: m, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch (_) {}
    return { status: r.status, body: j };
  };

  let g = await ecall('POST', '/' + backing.id + '/clone', {});
  t('clone refused', g.status === 400, g);
  g = await ecall('POST', '/' + backing.id + '/clone', { revision: true });
  t('revise refused', g.status === 400, g);
  g = await ecall('POST', '/' + backing.id + '/submit', {});
  t('submit refused', g.status === 400, g);
  g = await ecall('POST', '/' + backing.id + '/resubmit', { note: 'x' });
  t('resubmit refused', g.status === 400, g);
  g = await ecall('PUT', '/' + backing.id, { status: 'Won' });
  t('status change refused', g.status === 400, g);
  const notWon = db.prepare('SELECT status FROM estimates WHERE id = ?').get(backing.id);
  t('and the row did not move', notWon.status === 'Draft', notWon.status);

  // An ordinary save is exactly how the estimator works, so it must still pass.
  g = await ecall('PUT', '/' + backing.id, { fab_mh: 12 });
  t('ordinary save still allowed', g.status === 200, g.status);
  const saved = db.prepare('SELECT fab_mh, bid_number FROM estimates WHERE id = ?').get(backing.id);
  t('save landed', +saved.fab_mh === 12, saved.fab_mh);
  // The bid-number burn: saving a confirmed row used to mint a bid number.
  t('no bid number was burned', !saved.bid_number, saved.bid_number);

  // A real bid must be completely unaffected by all of the above.
  g = await ecall('PUT', '/2', { status: 'Won', job_number: 'J-2201' });
  t('a real bid can still change status', g.status === 200, g.status);

  console.log('\n--- 15. deleting an estimator CO takes its backing estimate ---');
  r = await call('DELETE', '/' + estCO.id);
  t('delete ok', r.status === 200, r.body);
  const gone = db.prepare('SELECT deleted_at FROM estimates WHERE id = ?').get(backing.id);
  t('backing estimate soft-deleted too', gone.deleted_at !== null, gone.deleted_at);

  console.log('\n' + (fail ? 'FAILURES: ' + fail + ' / ' + (pass+fail) : 'ALL ' + pass + ' CHECKS PASSED'));
  srv.close();
  process.exit(fail ? 1 : 0);
}

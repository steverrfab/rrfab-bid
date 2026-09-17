// Bid Calendar v2, end to end against the real server.js over a throwaway
// database. Covers:
//   - the one-time copy of open bids from the v1 calendar (adds calendar rows,
//     leaves every estimate exactly as it was, never runs twice)
//   - adding, editing and removing calendar bids, due time optional
//   - who can see and change which calendar bids
//   - linking (one estimate per calendar bid), unlinking, due date sync
//   - Start bid and Copy for this GC (new estimates, original untouched)
//   - the Project tab lookup, due-soon, reminder settings, reminder emails
// Run with:  node test/bid_calendar.test.js
const os = require('os'), fsx = require('fs'), pathx = require('path');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');

const DATA_DIR = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'caltest-'));
process.env.DATA_DIR = DATA_DIR;
const PORT = 4641;
const JWT_SECRET = 'test-secret';

// Days from today as YYYY-MM-DD (UTC is close enough for these checks).
const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const inHours = h => {
  // An Eastern wall-clock date/time h hours from now.
  const at = new Date(Date.now() + h * 36e5);
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(at);
  const g = {}; for (const x of p) g[x.type] = x.value;
  return { date: `${g.year}-${g.month}-${g.day}`, time: `${g.hour}:${g.minute}` };
};

// ---- seed a "live" database as it stands before v2 ----
let db = require('../db');
db.exec(`INSERT INTO users (id, email, name, role, active) VALUES
  (21,'boss@x.test','Boss','superadmin',1),
  (23,'joe@x.test','Joe Jenkins','estimator',1),
  (25,'mike@x.test','Mike R','estimator',1)`);
const soon = inHours(5);
db.prepare(`INSERT INTO estimates (id, project_name, bid_number, client_gc, status, created_by, is_alternate, confirmed, bid_date, bid_time, bid_type)
  VALUES (?,?,?,?,?,?,0,1,?,?,?)`).run(100, 'Towson Library Stair Package', '2073', 'Whiting-Turner', 'Draft', 23, day(7), '14:00', 'real');
const insE = db.prepare(`INSERT INTO estimates (id, project_name, bid_number, client_gc, status, created_by, is_alternate, confirmed, bid_date, bid_time, bid_type, deleted_at)
  VALUES (?,?,?,?,?,?,0,1,?,?,?,?)`);
insE.run(101, 'Dranesville ES Misc Metals', '2071', 'Howard Shockey', 'Draft', 23, soon.date, soon.time, 'real', null);   // copied, reminder due
insE.run(102, 'Legacy Date Bid', '2060', 'Clark', 'Draft', 25, '9/30/2026', null, null, null);                             // copied, M/D/YYYY, no time
insE.run(103, 'Columbia Mezzanine', '2059', 'Plano-Coudon', 'Submitted', 23, day(-3), '15:00', 'real', null);              // not copied (not open)
insE.run(104, 'Deleted Bid', '2058', 'Gilbane', 'Draft', 23, day(4), '10:00', 'real', day(-1));                             // not copied (deleted)
insE.run(105, 'Test Bid', '2057', 'Gilbane', 'Draft', 23, day(4), '10:00', 'test', null);                                   // not copied (test)
insE.run(106, 'No Date Draft', '2080', 'Hess', 'Draft', 23, '', null, 'real', null);                                        // not copied, linkable
insE.run(107, 'Glen Burnie High School - Handrails', '2079', 'Kinsley', 'Draft', 23, '', null, 'real', null);             // linkable
insE.run(108, 'Mike Draft', '2081', 'Clark', 'Draft', 25, '', null, 'real', null);                                          // Mike's
db.exec(`INSERT INTO takeoff_shapes (estimate_id, section_type, position, section_name) VALUES (100, 'misc', 0, 'Stairs')`);
// A reminder the v1 calendar already sent for bid 101 must not go out again.
const { dueAt } = require('../lib/bid_due');
db.prepare("INSERT INTO bid_reminders (estimate_id, user_id, kind, due_at, result) VALUES (101, 23, '24h', ?, 'sent')").run(dueAt(soon.date, soon.time).toISOString());
// Pretend v2 has never run on this database.
db.exec("DELETE FROM _data_fixes WHERE name = '062_calendar_from_estimates'");
db.exec('DELETE FROM bid_calendar');
const snapshot = () => JSON.stringify(db.prepare('SELECT * FROM estimates ORDER BY id').all());
const before = snapshot();
db.close();

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); } };
const tok = (id, role, name) => jwt.sign({ userId: id, email: 'x', name, role }, JWT_SECRET);
const T = { boss: tok(21, 'superadmin', 'Boss'), joe: tok(23, 'estimator', 'Joe Jenkins'), mike: tok(25, 'estimator', 'Mike R') };
const B = 'http://127.0.0.1:' + PORT;
async function call(who, m, p, body) {
  const h = { 'content-type': 'application/json' };
  if (who) h.authorization = 'Bearer ' + T[who];
  const r = await fetch(B + p, { method: m, headers: h, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { j = null; }
  return { status: r.status, body: j };
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const fresh = () => { delete require.cache[require.resolve('../db')]; return require('../db'); };

let child, log = '';
async function start() {
  log = '';
  child = spawn(process.execPath, ['server.js'], {
    cwd: pathx.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR, JWT_SECRET, BID_REMINDERS: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 60; i++) {
    await wait(250);
    try { const r = await fetch(B + '/api/health'); if (r.ok) return; } catch {}
  }
  console.log(log);
  throw new Error('server did not start');
}
async function stop() { child.kill(); await wait(500); }

async function run() {
  await start();
  const all = '/api/calendar?from=2020-01-01&to=2030-12-31';

  console.log('\n--- 1. copy of bids already on the v1 calendar ---');
  t('startup log reports the copy', /copied 3 open bid\(s\)/.test(log), log.split('\n').filter(l => /calendar/.test(l)));
  let r = await call('boss', 'GET', all + '&user=all');
  const copied = r.body.entries;
  t('three calendar bids copied', copied.length === 3, copied.map(e => e.project_name));
  const e100 = copied.find(e => e.estimate && e.estimate.id === 100);
  t('Towson copied as Whiting-Turner, 2 PM', e100 && e100.client_gc === 'Whiting-Turner' && e100.due_time === '14:00' && e100.due_date === day(7), e100);
  const e101 = copied.find(e => e.estimate && e.estimate.id === 101);
  const e102 = copied.find(e => e.estimate && e.estimate.id === 102);
  t('open bid copied with its time and owner', e101 && e101.due_time === soon.time && e101.assigned_to === 23 && e101.due_date === soon.date, e101);
  t('M/D/YYYY date converted, no time left blank', e102 && e102.due_date === '2026-09-30' && e102.due_time === '' && e102.assigned_to === 25, e102);
  t('submitted, deleted and test bids not copied', !copied.some(e => e.estimate && [103, 104, 105].includes(e.estimate.id)));
  let db2 = fresh();
  t('every estimate row exactly as before', JSON.stringify(db2.prepare('SELECT * FROM estimates ORDER BY id').all()) === before);
  db2.close();
  await stop(); await start();
  r = await call('boss', 'GET', all + '&user=all');
  t('restart does not copy again', r.body.entries.length === 3, r.body.entries.length);

  console.log('\n--- 2. add, edit, remove ---');
  r = await call('joe', 'POST', '/api/calendar', { project_name: '', due_date: day(14) });
  t('project required', r.status === 400 && /Project/.test(r.body.error), r);
  r = await call('joe', 'POST', '/api/calendar', { project_name: 'UMBC Lab Building Lintels', due_date: '' });
  t('due date required', r.status === 400 && /due date/.test(r.body.error), r);
  r = await call('joe', 'POST', '/api/calendar', { project_name: 'UMBC Lab Building Lintels', source: 'PlanHub', due_date: day(14), assigned_to: 25, docs_url: 'https://planhub.example/x' });
  t('no GC needed, time optional', r.status === 201 && r.body.due_time === '' && r.body.due_at === null && r.body.client_gc === '', r);
  t('estimator cannot assign to someone else', r.body.assigned_to === 23, r.body.assigned_to);
  t('fields saved', r.body.source === 'PlanHub' && r.body.docs_url === 'https://planhub.example/x' && r.body.estimate === null, r.body);
  t('start day defaults to 2 days before due', r.body.start_lead_days === 2 && r.body.start_date === day(12), [r.body.start_lead_days, r.body.start_date]);
  const umbc = r.body.id;
  r = await call('joe', 'POST', '/api/calendar', { project_name: 'Towson Library Stair Package', source: 'BuildingConnected', due_date: day(8), due_time: '12:00' });
  const towsonBM = r.body.id;
  t('second GC invite for the same job added', r.status === 201 && r.body.due_time === '12:00' && !!r.body.due_at, r);
  const towsonWT = e100.id;
  r = await call('boss', 'POST', '/api/calendar', { project_name: 'BWI Guardrail', due_date: day(10), assigned_to: 25 });
  t('admin can add one for Mike', r.status === 201 && r.body.assigned_to === 25 && r.body.estimator_name === 'Mike R', r.body);
  const bwi = r.body.id;
  r = await call('joe', 'PUT', '/api/calendar/' + umbc, { start_lead_days: 5 });
  t('start day follows the lead time', r.body.start_lead_days === 5 && r.body.start_date === day(9), [r.body.start_lead_days, r.body.start_date]);
  r = await call('joe', 'PUT', '/api/calendar/' + umbc, { start_lead_days: 99 });
  t('a lead time that is not offered falls back to 2 days', r.body.start_lead_days === 2, r.body.start_lead_days);
  r = await call('joe', 'PUT', '/api/calendar/' + umbc, { due_time: '11:00', notes: 'walkthrough Tue' });
  t('edit time and notes', r.status === 200 && r.body.due_time === '11:00' && r.body.notes === 'walkthrough Tue' && r.body.project_name === 'UMBC Lab Building Lintels', r.body);
  r = await call('joe', 'PUT', '/api/calendar/' + umbc, { due_time: '' });
  t('clear the time again', r.body.due_time === '', r.body);
  r = await call('joe', 'PUT', '/api/calendar/' + umbc, { project_name: ' ' });
  t('cannot blank the project', r.status === 400, r);
  r = await call('joe', 'PUT', '/api/calendar/reminder-settings', { morning_of: 1 });
  t('reminder settings still save (not mistaken for a calendar bid)', r.status === 200 && r.body.morning_of === 1, r);

  console.log('\n--- 3. who sees what ---');
  r = await call('joe', 'GET', all);
  t('Joe sees only his own', r.body.entries.every(e => e.assigned_to === 23) && r.body.entries.length === 4, r.body.entries.map(e => e.project_name));
  t('Joe gets no user list', r.body.users.length === 0);
  t('Joe\'s link picker: his unlinked drafts only', JSON.stringify(r.body.drafts.map(d => d.id).sort()) === JSON.stringify([106, 107]), r.body.drafts.map(d => d.id));
  r = await call('joe', 'GET', all + '&user=25');
  t('Joe cannot peek at Mike', r.body.entries.every(e => e.assigned_to === 23));
  r = await call('joe', 'GET', '/api/calendar/entry/' + umbc);
  t('Joe opens his calendar bid by id', r.status === 200 && r.body.id === umbc, r.status);
  r = await call('mike', 'GET', '/api/calendar/entry/' + umbc);
  t('Mike cannot open Joe\'s by id', r.status === 403, r.status);
  r = await call('mike', 'PUT', '/api/calendar/' + umbc, { notes: 'x' });
  t('Mike cannot edit Joe\'s', r.status === 403, r.status);
  r = await call('mike', 'DELETE', '/api/calendar/' + umbc);
  t('Mike cannot remove Joe\'s', r.status === 403, r.status);
  r = await call('boss', 'GET', all + '&user=25');
  t('admin views Mike', r.body.entries.length === 2 && r.body.entries.every(e => e.assigned_to === 25), r.body.entries);
  r = await call('boss', 'GET', `/api/calendar?from=${day(11)}&to=${day(13)}&user=23`);
  t('start day inside the window brings the bid in', r.body.entries.some(e => e.id === umbc), r.body.entries.map(e => e.id));

  console.log('\n--- 4. link, unlink, due date follows the calendar ---');
  r = await call('joe', 'POST', `/api/calendar/${towsonWT}/link`, { estimate_id: 106 });
  t('a calendar bid that already has an estimate cannot be relinked', r.status === 409 && /Unlink/.test(r.body.error), r);
  r = await call('joe', 'POST', `/api/calendar/${towsonBM}/link`, { estimate_id: 100 });
  t('same estimate cannot go on a second calendar bid', r.status === 409 && /already linked/.test(r.body.error), r);
  r = await call('joe', 'POST', `/api/calendar/${umbc}/link`, { estimate_id: 108 });
  t('Joe cannot link Mike\'s estimate', r.status === 409, r);
  r = await call('joe', 'POST', `/api/calendar/${umbc}/link`, { estimate_id: 104 });
  t('deleted estimate cannot be linked', r.status === 409, r);
  r = await call('joe', 'POST', `/api/calendar/${umbc}/link`, { estimate_id: 106 });
  t('link UMBC to 106', r.status === 200 && r.body.estimate.id === 106, r);
  r = await call('joe', 'GET', '/api/estimates/106');
  t('linked estimate got the calendar due date', r.body.estimate.bid_date === day(14), r.body.estimate.bid_date);
  r = await call('joe', 'PUT', '/api/calendar/' + umbc, { due_date: day(15) });
  r = await call('joe', 'GET', '/api/estimates/106');
  t('moving the calendar date moves the estimate date', r.body.estimate.bid_date === day(15), r.body.estimate.bid_date);
  t('and nothing else on it changed', r.body.estimate.project_name === 'No Date Draft' && r.body.estimate.client_gc === 'Hess' && r.body.estimate.status === 'Draft');
  r = await call('joe', 'GET', '/api/estimates');
  const row106 = r.body.rows.find(x => x.id === 106);
  const row107 = r.body.rows.find(x => x.id === 107);
  t('estimates list shows the calendar link', row106.calendar_id === umbc && row107.calendar_id === null, [row106.calendar_id, row107.calendar_id]);
  r = await call('joe', 'GET', '/api/calendar/for-estimate/106');
  t('Project tab lookup: linked', r.body.linked && r.body.linked.id === umbc, r.body);
  r = await call('joe', 'POST', `/api/calendar/${umbc}/unlink`);
  t('unlink', r.status === 200 && r.body.estimate === null, r);
  r = await call('joe', 'GET', '/api/estimates/106');
  t('unlink leaves the estimate as it was', r.body.estimate.bid_date === day(15) && r.body.estimate.project_name === 'No Date Draft');
  r = await call('joe', 'POST', '/api/calendar', { project_name: 'Pikesville Retail Stair', due_date: day(9), estimate_id: 106 });
  t('Project tab: add a bid to the calendar already linked', r.status === 201 && r.body.estimate && r.body.estimate.id === 106, r);
  const fromEst = r.body.id;
  r = await call('joe', 'GET', '/api/estimates/106');
  t('that estimate took the new calendar due date', r.body.estimate.bid_date === day(9), r.body.estimate.bid_date);
  r = await call('joe', 'POST', '/api/calendar', { project_name: 'Dup', due_date: day(9), estimate_id: 106 });
  t('an estimate cannot be added twice', r.status === 409, r.status);
  r = await call('joe', 'POST', '/api/calendar/' + fromEst + '/unlink');
  r = await call('joe', 'DELETE', '/api/calendar/' + fromEst);

  r = await call('joe', 'GET', '/api/calendar/for-estimate/107');
  const candIds = r.body.candidates.map(c => c.id);
  t('Project tab lookup: open unlinked calendar bids to pick from', !r.body.linked && candIds.includes(umbc) && candIds.includes(towsonBM) && !candIds.includes(towsonWT) && !candIds.includes(bwi), candIds);
  r = await call('mike', 'GET', '/api/calendar/for-estimate/107');
  t('Mike cannot look up Joe\'s estimate', r.status === 403, r.status);

  console.log('\n--- 5. Start bid ---');
  r = await call('boss', 'POST', `/api/calendar/${bwi}/start`, { job_type: 'full' });
  t('admin starts the bid for Mike', r.status === 201 && r.body.entry.estimate && r.body.estimate_id, r);
  const bwiEst = r.body.estimate_id;
  r = await call('mike', 'GET', '/api/estimates/' + bwiEst);
  const ne = r.body.estimate;
  t('new estimate is Mike\'s and he can open it', r.status === 200 && ne.created_by === 25, ne && ne.created_by);
  t('project and due date filled in, GC left for the estimator', ne.project_name === 'BWI Guardrail' && ne.client_gc === '' && ne.bid_date === day(10) && ne.status === 'Draft', ne);
  t('it has a bid number and Prepared By is Mike', !!ne.bid_number && ne.prepared_by === 'Mike R', [ne.bid_number, ne.prepared_by]);
  r = await call('boss', 'POST', `/api/calendar/${bwi}/start`, {});
  t('cannot start twice', r.status === 409, r.status);
  r = await call('joe', 'POST', `/api/calendar/${umbc}/start`, { job_type: 'process_only' });
  r = await call('joe', 'GET', '/api/estimates/' + r.body.estimate_id);
  t('process-only start works', r.body.estimate.job_type === 'process_only', r.body.estimate.job_type);

  console.log('\n--- 6. Copy for this GC ---');
  db2 = fresh();
  const src = JSON.stringify(db2.prepare('SELECT * FROM estimates WHERE id = 100').get());
  db2.close();
  r = await call('joe', 'GET', '/api/calendar/siblings/' + towsonBM);
  t('siblings lists the other GC\'s linked bid', r.body.entries.some(e => e.id === towsonWT && e.estimate.id === 100), r.body.entries.map(e => e.id));
  r = await call('mike', 'POST', `/api/calendar/${bwi}/copy`, { from_estimate_id: 100 });
  t('Mike cannot copy Joe\'s estimate', r.status === 409 || r.status === 403, r.status);
  r = await call('joe', 'POST', `/api/calendar/${towsonBM}/copy`, { from_estimate_id: 100 });
  t('copy for Barton Malow', r.status === 201 && r.body.estimate_id && r.body.estimate_id !== 100, r);
  const copyId = r.body.estimate_id;
  r = await call('joe', 'GET', '/api/estimates/' + copyId);
  const ce = r.body.estimate;
  t('copy has its own bid number', ce.bid_number && ce.bid_number !== '2073', ce.bid_number);
  t('copy takes the calendar bid\'s due date and keeps the name and the GC it was copied from', ce.client_gc === 'Whiting-Turner' && ce.bid_date === day(8) && ce.project_name === 'Towson Library Stair Package', ce);
  t('copy belongs to Joe and is a Draft', ce.created_by === 23 && ce.status === 'Draft');
  db2 = fresh();
  t('takeoff came along', db2.prepare('SELECT COUNT(*) n FROM takeoff_shapes WHERE estimate_id = ?').get(copyId).n === 1);
  t('original estimate untouched', JSON.stringify(db2.prepare('SELECT * FROM estimates WHERE id = 100').get()) === src);
  db2.close();
  r = await call('joe', 'POST', `/api/estimates/100/clone`);
  t('plain Clone now keeps the owner (was blank before)', r.status === 201 && r.body.estimate.created_by === 23, r.body && r.body.estimate && r.body.estimate.created_by);

  r = await call('joe', 'GET', '/api/calendar/for-estimate/' + copyId);
  const bmEntry = r.body.linked && r.body.linked.id;
  r = await call('joe', 'POST', `/api/estimates/${copyId}/clone`, { revision: true });
  t('Revise makes a new version', r.status === 201 && r.body.estimate.id !== copyId, r.status);
  const revId = r.body.estimate.id;
  r = await call('joe', 'GET', '/api/calendar/entry/' + bmEntry);
  t('the calendar bid moves to the new version', r.body.estimate && r.body.estimate.id === revId, r.body.estimate);

  console.log('\n--- 7. due-soon and reminder emails ---');
  r = await call('joe', 'GET', '/api/calendar/due-soon');
  t('due-soon has the bid due in 5 hrs', r.body.bids.length === 1 && r.body.bids[0].id === 101 && r.body.bids[0].calendar_id === e101.id, r.body.bids);
  const { runOnce } = require('../lib/bid_reminders');
  db2 = fresh();
  const s1 = inHours(3);
  db2.prepare("INSERT INTO bid_calendar (project_name, client_gc, due_date, due_time, assigned_to, created_by) VALUES ('Not Started Yet','Hess',?,?,23,23)").run(s1.date, s1.time);
  const noTime = inHours(3);
  db2.prepare("INSERT INTO bid_calendar (project_name, client_gc, due_date, due_time, assigned_to, created_by) VALUES ('No Time','Hess',?,NULL,23,23)").run(noTime.date);
  await runOnce(db2);
  const sent = db2.prepare('SELECT c.project_name, r.kind FROM calendar_reminders r JOIN bid_calendar c ON c.id = r.entry_id').all();
  t('reminder logged for the not-started bid', sent.some(s => s.project_name === 'Not Started Yet' && s.kind === '24h'), sent);
  t('no repeat of the reminder v1 already sent', !sent.some(s => s.project_name === 'Dranesville ES Misc Metals' && s.kind === '24h'), sent);
  t('no reminder for a bid with no time', !sent.some(s => s.project_name === 'No Time'), sent);
  const n1 = db2.prepare('SELECT COUNT(*) n FROM calendar_reminders').get().n;
  await runOnce(db2);
  t('second pass sends nothing new', db2.prepare('SELECT COUNT(*) n FROM calendar_reminders').get().n === n1);
  db2.prepare("UPDATE estimates SET status = 'Submitted' WHERE id = 101").run();
  r = await call('joe', 'GET', '/api/calendar/due-soon');
  t('submitted bid drops out of due-soon', r.body.bids.every(b => b.id !== 101), r.body.bids);
  db2.close();

  console.log('\n--- 8. remove ---');
  r = await call('joe', 'DELETE', '/api/calendar/' + towsonWT);
  t('removed', r.status === 200);
  r = await call('joe', 'GET', all);
  t('gone from the calendar', !r.body.entries.some(e => e.id === towsonWT));
  r = await call('joe', 'GET', '/api/estimates/100');
  t('its estimate is still there, unchanged', r.status === 200 && r.body.estimate.project_name === 'Towson Library Stair Package' && !r.body.estimate.deleted_at);
  r = await call('joe', 'GET', '/api/calendar/for-estimate/100');
  t('estimate 100 is free to link again', r.body.linked === null, r.body);
  r = await call('joe', 'POST', `/api/calendar/${towsonBM}/link`, { estimate_id: 100 });
  t('but Barton Malow already has its copy', r.status === 409, r.status);
}

run()
  .catch(e => { fail++; console.error(e); })
  .finally(() => {
    try { child && child.kill(); } catch {}
    console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nALL ${pass} CHECKS PASSED`);
    process.exit(fail ? 1 : 0);
  });

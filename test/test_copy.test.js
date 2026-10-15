// Test copy loading, end to end against the real server.js. Covers:
//
//   - only a superadmin can download a database snapshot from the live app
//   - the live app (no TEST_COPY) has no load door at all
//   - the test copy refuses a load without the right SEED_KEY, and junk files
//   - a load swaps the live data in after a restart
//   - the test copy hands out a set-password link instead of emailing
//
// Run with:  node test/test_copy.test.js
const os = require('os'), fsx = require('fs'), pathx = require('path');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');

const LIVE_DIR = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'tc-live-'));
const TEST_DIR = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'tc-test-'));
const LIVE_PORT = 4681, TEST_PORT = 4682, PULL_PORT = 4683;
const PULL_DIR = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'tc-pull-'));
const JWT_SECRET = 'test-secret';

process.env.DATA_DIR = LIVE_DIR;
const db = require('../db');
db.exec(`INSERT INTO users (id, email, name, role, active) VALUES
  (51,'boss@x.test','Boss','superadmin',1), (52,'adm@x.test','Adm','admin',1)`);
db.exec(`INSERT INTO estimates (id, project_name, bid_number, status, created_by) VALUES (777,'Live Job','2701','Submitted',51)`);
db.close();

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); } };
const wait = ms => new Promise(r => setTimeout(r, ms));
const tok = (id, role) => jwt.sign({ userId: id, email: 'x', name: 'x', role }, JWT_SECRET);

const kids = [];
async function start(port, dir, env = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: pathx.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, JWT_SECRET, BID_REMINDERS: 'off', TEST_COPY: '', SEED_KEY: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  kids.push(child);
  let log = ''; child.stdout.on('data', d => { log += d; child.log = log; }); child.stderr.on('data', d => { log += d; child.log = log; });
  for (let i = 0; i < 80; i++) {
    await wait(250);
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return child; } catch {}
  }
  console.log(log); throw new Error('server did not start');
}

async function run() {
  await start(LIVE_PORT, LIVE_DIR, { TEST_COPY_PULL_KEY: 'p'.repeat(40) });
  const L = `http://127.0.0.1:${LIVE_PORT}`;

  let r = await fetch(L + '/api/settings/snapshot', { headers: { authorization: 'Bearer ' + tok(52, 'admin') } });
  t('an admin who is not superadmin cannot download a snapshot', r.status === 403, r.status);
  r = await fetch(L + '/api/settings/snapshot');
  t('no login, no snapshot', r.status === 401, r.status);
  r = await fetch(L + '/api/settings/snapshot', { headers: { authorization: 'Bearer ' + tok(51, 'superadmin') } });
  const snap = Buffer.from(await r.arrayBuffer());
  t('superadmin downloads a real database file', r.status === 200 && snap.slice(0, 15).toString() === 'SQLite format 3', r.status);

  r = await fetch(L + '/api/test-copy/seed', { method: 'POST', headers: { 'x-integration-key': 'anything', 'content-type': 'application/octet-stream' }, body: snap });
  t('the live app has no load door', r.status === 401 || r.status === 404, r.status);

  const SEED = 'k'.repeat(40);
  const testEnv = { TEST_COPY: '1', SEED_KEY: SEED, FRONTEND_URL: 'https://test.example' };
  let child = await start(TEST_PORT, TEST_DIR, testEnv);
  const T = `http://127.0.0.1:${TEST_PORT}`;
  let h = await (await fetch(T + '/api/health')).json();
  t('test copy starts empty', h.estimates === 0, h);

  r = await fetch(T + '/api/test-copy/seed', { method: 'POST', headers: { 'x-integration-key': 'wrong'.padEnd(40, 'x'), 'content-type': 'application/octet-stream' }, body: snap });
  t('wrong key is refused', r.status === 404, r.status);
  r = await fetch(T + '/api/test-copy/seed', { method: 'POST', headers: { 'x-integration-key': SEED, 'content-type': 'application/octet-stream' }, body: Buffer.alloc(500, 1) });
  t('a file that is not a database is refused', r.status === 400, r.status);

  r = await fetch(T + '/api/test-copy/seed', { method: 'POST', headers: { 'x-integration-key': SEED, 'content-type': 'application/octet-stream' }, body: snap });
  t('load accepted', r.status === 200, r.status);
  await wait(1500);
  t('process exits so Railway restarts it', child.exitCode === 1, child.exitCode);
  child = await start(TEST_PORT, TEST_DIR, testEnv); // what Railway's on-failure restart does
  h = await (await fetch(T + '/api/health')).json();
  t('after restart the test copy has the live data', h.estimates === 1, h);
  t('seed file is used up', !fsx.existsSync(pathx.join(TEST_DIR, 'seed.db')));

  r = await fetch(T + '/api/test-copy/invite', { method: 'POST', headers: { 'x-integration-key': SEED, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'BOSS@x.test' }) });
  const inv = await r.json();
  t('set-password link for an existing user', r.status === 200 && /^https:\/\/test\.example\/#\/invite\/[0-9a-f]{64}$/.test(inv.link), inv);
  const info = await (await fetch(T + '/api/auth/invite/' + inv.link.split('/').pop())).json();
  t('the link works on the test copy', info && /boss@x\.test/i.test(JSON.stringify(info)), info);

  // ---- pull at startup, the way the Railway test copy loads ----
  r = await fetch(L + '/api/backup/test-copy-db', { headers: { 'x-integration-key': 'wrong' } });
  t('live refuses a pull with the wrong key', r.status === 401, r.status);
  const pullEnv = { TEST_COPY: '1', SEED_KEY: SEED, FRONTEND_URL: 'https://test.example', SEED_FROM_URL: L, SEED_PULL_KEY: 'p'.repeat(40), SEED_PULL_ID: 'one', SEED_INVITE_EMAIL: 'boss@x.test' };
  let pc = await start(PULL_PORT, PULL_DIR, pullEnv);
  const P = `http://127.0.0.1:${PULL_PORT}`;
  for (let i = 0; i < 40 && pc.exitCode === null; i++) await wait(250);
  t('test copy pulls live data on first start, then restarts', pc.exitCode === 1, pc.log && pc.log.slice(-300));
  pc = await start(PULL_PORT, PULL_DIR, pullEnv);
  h = await (await fetch(P + '/api/health')).json();
  t('after restart it has the live data', h.estimates === 1, h);
  await wait(500);
  const m = (pc.log || '').match(/set-password link for boss@x\.test: (\S+)/);
  t('a set-password link is written to the log', !!m && /^https:\/\/test\.example\/#\/invite\/[0-9a-f]{64}$/.test(m[1]), pc.log && pc.log.slice(-400));
  pc.kill(); await wait(300);
  pc = await start(PULL_PORT, PULL_DIR, pullEnv);
  await wait(1500);
  t('it does not pull again or loop on the same pull id', pc.exitCode === null && !/pulling live data/.test(pc.log || ''), pc.log && pc.log.slice(-300));

  // Live is untouched by any of this.
  h = await (await fetch(L + '/api/health')).json();
  t('live still has its one estimate', h.estimates === 1, h);
}

run()
  .catch(err => { fail++; console.error(err); })
  .finally(() => {
    for (const k of kids) { try { k.kill(); } catch {} }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });

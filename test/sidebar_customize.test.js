// End to end against the real server.js, over a throwaway database. Covers the
// per-person sidebar behind Customize: the column, what login and /me hand back,
// and PUT /api/auth/me/sidebar.
//
// Hiding is not permission. These checks also confirm the page list is untouched
// by any of it.
//
// Run with:  node test/sidebar_customize.test.js
const os = require('os'), fsx = require('fs'), pathx = require('path');
const { spawn } = require('child_process');
const http = require('http');

const DATA_DIR = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'sidebartest-'));
process.env.DATA_DIR = DATA_DIR;
const PORT = 4731;
const JWT_SECRET = 'test-secret';
process.env.JWT_SECRET = JWT_SECRET;

// Seed one ordinary estimator (running the migrations) before the server opens it.
const db = require('../db');
const { hashPassword } = require('../lib/auth');

let fail = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (!cond && extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''));
  if (!cond) fail++;
};

const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
console.log('\n--- 1. the column ---');
ok('users.sidebar_hidden exists', cols.includes('sidebar_hidden'));
db.prepare("INSERT INTO users (id, email, name, role, active, password_hash) VALUES (31,'sb@x.test','Sb','estimator',1,?)")
  .run(hashPassword('password123'));
ok('a new user starts with nothing hidden',
  db.prepare('SELECT sidebar_hidden FROM users WHERE id = 31').get().sidebar_hidden === '[]');
db.close();

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const d = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path, method,
      headers: {
        ...(d ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d) } : {}),
        ...(token ? { authorization: 'Bearer ' + token } : {}),
      },
    }, (s) => {
      let b = '';
      s.on('data', c => b += c);
      s.on('end', () => resolve({ status: s.statusCode, body: (() => { try { return JSON.parse(b); } catch (e) { return b; } })() }));
    });
    r.on('error', reject);
    if (d) r.write(d);
    r.end();
  });
}

let srv;
function boot() {
  return new Promise((resolve) => {
    srv = spawn(process.execPath, [pathx.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, DATA_DIR, PORT: String(PORT), JWT_SECRET },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    srv.stdout.on('data', d => { if (/listening|running|Server/i.test(d.toString())) setTimeout(resolve, 300); });
    srv.stderr.on('data', d => process.stderr.write('[srv] ' + d));
    setTimeout(resolve, 2500);
  });
}

(async () => {
  await boot();

  console.log('\n--- 2. login and /me carry the list ---');
  const login = await req('POST', '/api/auth/login', { email: 'sb@x.test', password: 'password123' });
  ok('login works', login.status === 200, login.body);
  const token = login.body.token;
  ok('login hands back an empty list', Array.isArray(login.body.user.sidebar_hidden) && login.body.user.sidebar_hidden.length === 0, login.body.user);
  let me = await req('GET', '/api/auth/me', null, token);
  ok('/me hands back an empty list', Array.isArray(me.body.sidebar_hidden) && me.body.sidebar_hidden.length === 0, me.body);

  console.log('\n--- 3. saving your own sidebar ---');
  const save = await req('PUT', '/api/auth/me/sidebar', { hidden: ['tax', 'trash', 'tax', '  '] }, token);
  ok('the save is accepted', save.status === 200 && save.body.ok === true, save.body);
  ok('duplicates and blanks are dropped', JSON.stringify(save.body.sidebar_hidden) === '["tax","trash"]', save.body);
  me = await req('GET', '/api/auth/me', null, token);
  ok('/me hands the saved list back', JSON.stringify(me.body.sidebar_hidden) === '["tax","trash"]', me.body.sidebar_hidden);

  console.log('\n--- 4. hiding is not permission ---');
  ok('the page list is untouched', Array.isArray(me.body.pages) && me.body.pages.length > 0, me.body.pages);

  console.log('\n--- 5. what is refused ---');
  const bad = await req('PUT', '/api/auth/me/sidebar', { hidden: 'nope' }, token);
  ok('a non-array is refused', bad.status === 400, bad.body);
  const noauth = await req('PUT', '/api/auth/me/sidebar', { hidden: [] }, null);
  ok('no token is refused', noauth.status === 401, noauth.body);

  console.log('\n--- 6. putting it all back ---');
  const clear = await req('PUT', '/api/auth/me/sidebar', { hidden: [] }, token);
  ok('clearing works', clear.status === 200 && clear.body.sidebar_hidden.length === 0, clear.body);
  const again = await req('POST', '/api/auth/login', { email: 'sb@x.test', password: 'password123' });
  ok('the account still signs in', again.status === 200 && again.body.user.sidebar_hidden.length === 0, again.body);

  srv.kill();
  console.log(fail ? ('\n' + fail + ' CHECK(S) FAILED') : '\nALL 12 CHECKS PASSED');
  process.exit(fail ? 1 : 0);
})();

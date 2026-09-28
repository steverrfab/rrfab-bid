'use strict';
// Real WAL-mode SQLite, a local stand-in object store, and actual download/
// decompression/read-only restore checks. No production data or credentials.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { createBackup, periodsAt, inspectDatabase } = require('../lib/backblaze_backup');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-test-'));
const db = new Database(path.join(root, 'source.db'));
db.pragma('journal_mode = WAL');
db.exec("CREATE TABLE estimates(id INTEGER PRIMARY KEY, bid_number TEXT, total REAL); CREATE TABLE users(id INTEGER PRIMARY KEY); CREATE TABLE change_orders(id INTEGER PRIMARY KEY); INSERT INTO estimates VALUES(1, 'TEST-BID', 1234.56); INSERT INTO users VALUES(1)");
const objects = new Map(), calls = [], notices = [];
let status = 200, transientFailures = 0, corrupt = false;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    calls.push({ method: req.method, url: req.url, headers: req.headers });
    if (transientFailures-- > 0) { res.writeHead(503); return res.end('transient'); }
    if (status !== 200) { res.writeHead(status); return res.end('secret-canary TESTSECRET'); }
    if (req.method === 'PUT') objects.set(req.url, Buffer.concat(chunks));
    if (!objects.has(req.url)) { res.writeHead(404); return res.end(); }
    res.writeHead(200);
    if (req.method === 'GET') {
      const data = Buffer.from(objects.get(req.url));
      if (corrupt) data[0] ^= 1;
      return res.end(data);
    }
    res.end();
  });
});
let passed = 0;
function check(name, fn) { fn(); passed++; console.log('  ok   ' + name); }

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { enabled: true, endpoint: 'https://s3.us-east-005.backblazeb2.com',
    region: 'us-east-005', bucket: 'test-bid-backups', prefix: 'projects/rrfab-bid/',
    keyId: 'TESTKEYID', secret: 'TESTSECRET', utcTime: '06:17', dataDir: root,
    alertTo: 'owner@example.com' };
  let at = new Date('2026-09-25T08:00:00.000Z');
  const fetchImpl = (url, options) => {
    assert.ok(url.startsWith(config.endpoint + '/' + config.bucket + '/' + config.prefix));
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    return fetch('http://127.0.0.1:' + server.address().port + new URL(url).pathname, options);
  };
  const options = { config, fetchImpl, now: () => at, retryDelayMs: 1,
    notify: async (to, detail) => { notices.push({ to, ...detail }); return { ok: true }; } };
  const disabled = createBackup({ ...options, config: { ...config, enabled: false } });
  assert.deepEqual(await disabled.runOnce(db), { skipped: true });
  check('disabled configuration performs no requests', () => assert.equal(calls.length, 0));
  let backup = createBackup(options);
  const before = db.prepare('SELECT * FROM estimates').all();
  const initial = await backup.runOnce(db);
  check('first run creates and verifies daily, weekly and monthly copies', () => {
    assert.equal(initial.ok, true);
    assert.equal(initial.objects.length, 3);
    assert.equal(objects.size, 6);
    assert.equal(calls.length, 12);
  });
  check('WAL data is restored and existing bids are unchanged', () => {
    assert.deepEqual(db.prepare('SELECT * FROM estimates').all(), before);
    const manifest = JSON.parse(objects.get('/' + config.bucket + '/' + initial.objects[0].manifestKey));
    assert.equal(manifest.tableRowCounts.estimates, 1);
    assert.equal(manifest.tableRowCounts.users, 1);
    assert.equal(manifest.integrityCheck, 'ok');
    const archive = objects.get('/' + config.bucket + '/' + initial.objects[0].key);
    const copyPath = path.join(root, 'verified.db');
    fs.writeFileSync(copyPath, require('zlib').gunzipSync(archive));
    const copy = new Database(copyPath, { readonly: true });
    assert.deepEqual(copy.prepare('SELECT * FROM estimates').all(), before);
    copy.close();
    assert.equal(crypto.createHash('sha256').update(archive).digest('hex'), manifest.archiveSha256);
  });
  check('every PUT requests encryption and every request is signed for the B2 region', () => {
    for (const call of calls) {
      assert.match(call.headers.authorization, /^AWS4-HMAC-SHA256 Credential=TESTKEYID\/20260925\/us-east-005\/s3\/aws4_request/);
      assert.match(call.headers.authorization, /Signature=[a-f0-9]{64}$/);
      assert.match(call.headers['x-amz-content-sha256'], /^[a-f0-9]{64}$/);
      if (call.method === 'PUT') assert.equal(call.headers['x-amz-server-side-encryption'], 'AES256');
    }
  });
  check('state contains no key material', () => {
    const saved = fs.readFileSync(path.join(root, 'b2-backup-state.json'), 'utf8');
    assert.ok(!saved.includes(config.secret));
    assert.ok(!saved.includes(config.keyId));
    assert.ok(!JSON.stringify(backup.state).includes(config.secret));
  });
  check('offline restore creates a verified new file and refuses overwrites or a bad manifest', () => {
    const archivePath = path.join(root, 'download.db.gz');
    const manifestPath = path.join(root, 'download.manifest.json');
    const outputPath = path.join(root, 'offline-restored.db');
    fs.writeFileSync(archivePath, objects.get('/' + config.bucket + '/' + initial.objects[0].key));
    fs.writeFileSync(manifestPath, objects.get('/' + config.bucket + '/' + initial.objects[0].manifestKey));
    const { verifyArchive } = require('../scripts/verify_b2_backup');
    const summary = verifyArchive(archivePath, manifestPath, outputPath);
    assert.equal(summary.integrityCheck, 'ok');
    assert.equal(summary.tableRowCounts.estimates, 1);
    assert.throws(() => verifyArchive(archivePath, manifestPath, outputPath), /already exists/);
    const wrongManifest = JSON.parse(fs.readFileSync(manifestPath));
    wrongManifest.archiveSha256 = 'bad';
    fs.writeFileSync(manifestPath, JSON.stringify(wrongManifest));
    assert.throws(() => verifyArchive(archivePath, manifestPath, path.join(root, 'refused.db')), /checksum/);
    assert.equal(fs.existsSync(path.join(root, 'refused.db')), false);
  });
  backup = createBackup(options);
  check('restart skips an already verified day', () => assert.equal(backup.state.lastSuccessAt, null));
  assert.deepEqual(await backup.runOnce(db), { skipped: true });
  check('restart loads last verification from persistent storage', () => assert.equal(backup.state.lastVerifiedAt, at.toISOString()));

  at = new Date('2026-09-26T08:00:00.000Z');
  const nextDay = await backup.runOnce(db);
  check('ordinary nights add only a daily copy', () => assert.equal(nextDay.objects.length, 1));
  at = new Date('2026-09-28T08:00:00.000Z');
  const nextWeek = await backup.runOnce(db);
  check('new week adds daily and weekly copies', () => assert.equal(nextWeek.objects.length, 2));
  at = new Date('2026-10-01T08:00:00.000Z');
  const nextMonth = await backup.runOnce(db);
  check('new month adds daily and monthly copies', () => assert.equal(nextMonth.objects.length, 2));
  check('UTC boundary and Sunday map to the right backup periods', () => {
    assert.deepEqual(periodsAt(new Date('2026-10-01T06:16:59Z'), '06:17'), { daily: '2026-09-30', weekly: '2026-09-28', monthly: '2026-09' });
    assert.deepEqual(periodsAt(new Date('2026-10-04T06:17:00Z'), '06:17'), { daily: '2026-10-04', weekly: '2026-09-28', monthly: '2026-10' });
  });

  const lastGood = backup.state.lastSuccessAt;
  at = new Date('2026-10-02T08:00:00.000Z');
  corrupt = true;
  const badCopy = await backup.runOnce(db);
  check('corrupt downloaded bytes fail verification and preserve last good status', () => {
    assert.equal(badCopy.ok, false);
    assert.match(badCopy.error, /checksum/);
    assert.equal(backup.state.lastSuccessAt, lastGood);
    assert.equal(backup.state.completedPeriods.daily, '2026-10-01');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].kind, 'failure');
  });
  assert.deepEqual(await backup.runOnce(db), { skipped: true });
  check('failed runs wait 15 minutes before another full attempt', () => assert.equal(backup.state.consecutiveFailures, 1));
  corrupt = false;
  status = 403;
  at = new Date('2026-10-02T08:16:00.000Z');
  const callCount = calls.length;
  const forbidden = await backup.runOnce(db);
  check('permanent failure is not retried and provider error bodies stay private', () => {
    assert.equal(calls.length - callCount, 1);
    assert.equal(forbidden.error, 'B2 PUT returned HTTP 403');
    assert.ok(!JSON.stringify(backup.state).includes('secret-canary'));
    assert.equal(notices.length, 1);
  });
  status = 200;
  transientFailures = 2;
  at = new Date('2026-10-02T08:32:00.000Z');
  const recovered = await backup.runOnce(db);
  check('transient requests retry, recovery resets failure state and sends one notice', () => {
    assert.equal(recovered.ok, true);
    assert.equal(backup.state.consecutiveFailures, 0);
    assert.equal(backup.state.lastError, null);
    assert.equal(notices.length, 2);
    assert.equal(notices[1].kind, 'recovery');
  });

  const invalid = createBackup({ ...options, config: { ...config, endpoint: 'http://unsafe.example', alertTo: '' } });
  const callsBeforeInvalid = calls.length;
  const rejected = await invalid.runOnce(db, { force: true });
  check('unsafe destination is rejected before any network request', () => {
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /HTTPS/);
    assert.equal(calls.length, callsBeforeInvalid);
  });

  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let first = true;
  at = new Date('2026-10-03T08:00:00.000Z');
  const concurrent = createBackup({ ...options, fetchImpl: async (...args) => {
    if (first) { first = false; entered(); await gate; }
    return fetchImpl(...args);
  } });
  const inFlight = concurrent.runOnce(db);
  await ready;
  assert.deepEqual(await concurrent.runOnce(db), { skipped: true });
  release();
  assert.equal((await inFlight).ok, true);
  check('overlapping backup calls are skipped', () => assert.equal(concurrent.state.running, false));
  check('backup module never issues a remote delete', () => assert.ok(calls.every(call => ['PUT', 'GET'].includes(call.method))));
  check('invalid database cannot pass the read-only restore check', () => {
    const broken = path.join(root, 'broken.db');
    fs.writeFileSync(broken, 'not a database');
    assert.throws(() => inspectDatabase(broken));
  });

  // Exercise the real notification adapter with a mocked Graph transport.
  const savedFetch = global.fetch;
  const envNames = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_SENDER_USER'];
  const savedEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  envNames.forEach(name => { process.env[name] = 'test-only'; });
  let sentMail;
  global.fetch = async (url, init) => {
    if (url.includes('/oauth2/')) return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }), { status: 200 });
    sentMail = JSON.parse(init.body);
    return new Response(null, { status: 202 });
  };
  try {
    const result = await require('../lib/email').sendBackupNotification('owner@example.com', { kind: 'failure', lastSuccessAt: lastGood, lastError: 'B2 PUT returned HTTP 403' });
    check('operations email uses the approved recipient without database contents or credentials', () => {
      assert.equal(result.ok, true);
      assert.equal(sentMail.message.toRecipients[0].emailAddress.address, 'owner@example.com');
      assert.equal(sentMail.message.body.contentType, 'Text');
      assert.ok(!JSON.stringify(sentMail).includes('TEST-BID'));
      assert.ok(!JSON.stringify(sentMail).includes('test-token'));
      assert.equal(sentMail.message.attachments, undefined);
    });
  } finally {
    global.fetch = savedFetch;
    for (const name of envNames) savedEnv[name] === undefined ? delete process.env[name] : process.env[name] = savedEnv[name];
  }
  console.log('\nALL ' + passed + ' BACKBLAZE CHECKS PASSED');
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => {
  db.close();
  server.close();
  // Only this test's freshly created temporary directory is removed.
  fs.rmSync(root, { recursive: true, force: true });
});

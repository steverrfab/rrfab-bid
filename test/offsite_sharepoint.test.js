// SharePoint off-site backup: token handling, site resolution, both upload
// paths, and the failure reporting.
//
// Microsoft cannot be called from here, so global fetch is replaced with a stub
// that records every request and answers with what Graph would. That proves the
// URLs, the headers and the chunking are right up to the wire, which is where
// the mistakes in this kind of code actually live.
const os = require('os'), fs = require('fs'), p = require('path');
process.env.DATA_DIR = fs.mkdtempSync(p.join(os.tmpdir(), 'sp-'));

let pass = 0, fail = 0;
const t = (n, c, x) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + ' -> ' + JSON.stringify(x))); };

// ---- fetch stub ----
const calls = [];
let tokenCalls = 0;
const routes = [];           // [{ match(url, opts), reply(url, opts) }]
const realFetch = global.fetch;

function reply(status, bodyObj, text) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => bodyObj,
    text: async () => (text != null ? text : JSON.stringify(bodyObj || {}))
  };
}

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push({ url: u, opts });
  if (u.includes('login.microsoftonline.com')) {
    tokenCalls++;
    return reply(200, { access_token: 'TOKEN-' + tokenCalls, expires_in: 3600 });
  }
  for (const r of routes) {
    if (r.match(u, opts)) return r.reply(u, opts);
  }
  return reply(404, null, 'no stub for ' + u);
};

function resetRoutes() { routes.length = 0; }
function graphOk() {
  resetRoutes();
  routes.push({
    match: u => /\/sites\/[^/]+$/.test(u),
    reply: () => reply(200, { id: 'SITEID123' })
  });
  routes.push({
    match: u => u.endsWith('/drives'),
    reply: () => reply(200, { value: [{ id: 'DRIVE-DOCS', name: 'Documents' }, { id: 'DRIVE-BK', name: 'Backups' }] })
  });
  routes.push({
    match: (u, o) => u.includes(':/content') && o.method === 'PUT',
    reply: () => reply(201, { id: 'ITEM1' })
  });
  routes.push({
    match: u => u.includes('createUploadSession'),
    reply: () => reply(200, { uploadUrl: 'https://upload.example/session/abc' })
  });
  routes.push({
    match: u => u.startsWith('https://upload.example/session/'),
    reply: (u, o) => {
      const range = o.headers['Content-Range'];
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(range);
      const done = m && Number(m[2]) === Number(m[3]) - 1;
      return done ? reply(201, { id: 'BIGITEM' }) : reply(202, {});
    }
  });
}

function loadSp() {
  delete require.cache[require.resolve('../lib/offsite_sharepoint')];
  return require('../lib/offsite_sharepoint');
}

(async () => {
  console.log('\n--- 1. unconfigured is inert ---');
  let sp = loadSp();
  t('not configured with nothing set', sp.isConfigured() === false);
  t('names what is missing', sp.missingConfig().includes('BACKUP_SP_SITE'), sp.missingConfig());
  let threw = '';
  try { await sp.upload(Buffer.from('x')); } catch (e) { threw = e.message; }
  t('upload refuses rather than half-trying', /not configured/i.test(threw), threw);
  t('and made no network calls', calls.length === 0, calls.length);

  console.log('\n--- 2. configured ---');
  process.env.AZURE_TENANT_ID = 'TENANT';
  process.env.AZURE_CLIENT_ID = 'CLIENT';
  process.env.AZURE_CLIENT_SECRET = 'SECRET';
  process.env.BACKUP_SP_SITE = 'rrfabrication.sharepoint.com:/sites/Operations';
  sp = loadSp();
  t('configured now', sp.isConfigured() === true);
  t('nothing missing', sp.missingConfig().length === 0, sp.missingConfig());

  console.log('\n--- 3. a small upload goes straight to /content ---');
  graphOk();
  calls.length = 0;
  const now = new Date('2026-09-03T14:05:06.789Z');
  const small = Buffer.alloc(1024, 7);
  let out = await sp.upload(small, now);
  const put = calls.find(c => c.opts.method === 'PUT');
  t('dated path, one folder per day', out.path === 'BidToolBackups/2026/09/03/rrbid-2026-09-03T14-05-06-789Z.db', out.path);
  t('bytes reported', out.bytes === 1024, out.bytes);
  t('site resolved by hostname:/path', calls.some(c => c.url.endsWith('/sites/rrfabrication.sharepoint.com:/sites/Operations')), calls.map(c => c.url));
  t('uploaded to the default library', put.url.includes('/sites/SITEID123/drive/root:/'), put.url);
  t('simple content PUT', put.url.endsWith(':/content'), put.url);
  t('bearer token attached', put.opts.headers.Authorization === 'Bearer TOKEN-1', put.opts.headers.Authorization);
  t('sent as octet-stream', put.opts.headers['Content-Type'] === 'application/octet-stream');
  t('body is the snapshot', put.opts.body.length === 1024);

  console.log('\n--- 4. the token is cached, not refetched every run ---');
  const before = tokenCalls;
  await sp.upload(small, now);
  t('no second token request', tokenCalls === before, [before, tokenCalls]);

  console.log('\n--- 5. a large upload switches to a resumable session ---');
  graphOk();
  calls.length = 0;
  const big = Buffer.alloc(sp.SIMPLE_UPLOAD_LIMIT + 12345, 3);
  out = await sp.upload(big, now);
  const sessionCreates = calls.filter(c => c.url.includes('createUploadSession'));
  const chunks = calls.filter(c => c.url.startsWith('https://upload.example/session/'));
  t('one session created', sessionCreates.length === 1, sessionCreates.length);
  t('no simple content PUT used', !calls.some(c => c.url.includes(':/content')), calls.map(c => c.url));
  t('sent in more than one chunk', chunks.length > 1, chunks.length);
  const ranges = chunks.map(c => c.opts.headers['Content-Range']);
  t('first chunk starts at zero', /^bytes 0-/.test(ranges[0]), ranges[0]);
  t('last chunk ends at the final byte', ranges[ranges.length - 1].endsWith('-' + (big.length - 1) + '/' + big.length), ranges[ranges.length - 1]);
  // Every byte exactly once, no gaps and no overlap: the classic chunking bug.
  let cursor = 0, contiguous = true;
  for (const r of ranges) {
    const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(r);
    if (Number(m[1]) !== cursor) { contiguous = false; break; }
    cursor = Number(m[2]) + 1;
  }
  t('chunks are contiguous and cover the whole file', contiguous && cursor === big.length, [cursor, big.length]);
  t('chunk size is a multiple of 320 KiB', chunks.slice(0, -1).every(c => c.opts.body.length % (320 * 1024) === 0), chunks.map(c => c.opts.body.length));

  console.log('\n--- 6. a named library is resolved by name ---');
  process.env.BACKUP_SP_LIBRARY = 'Backups';
  sp = loadSp();
  graphOk();
  calls.length = 0;
  await sp.upload(small, now);
  const put2 = calls.find(c => c.opts.method === 'PUT' && c.url.includes(':/content'));
  t('writes to the named library', put2.url.includes('/drives/DRIVE-BK/root:/'), put2.url);

  console.log('\n--- 7. failures are raised, not swallowed ---');
  process.env.BACKUP_SP_LIBRARY = 'Nope';
  sp = loadSp();
  graphOk();
  threw = '';
  try { await sp.upload(small, now); } catch (e) { threw = e.message; }
  t('a missing library is a clear error', /No document library named "Nope"/.test(threw), threw);
  t('and it lists what does exist', /Documents/.test(threw), threw);

  delete process.env.BACKUP_SP_LIBRARY;
  sp = loadSp();
  resetRoutes();
  routes.push({ match: u => /\/sites\/[^/]+$/.test(u), reply: () => reply(403, null, 'Access denied') });
  threw = '';
  try { await sp.upload(small, now); } catch (e) { threw = e.message; }
  t('a permission problem names the site', /Could not find the SharePoint site/.test(threw) && /403/.test(threw), threw);

  graphOk();
  routes.unshift({
    match: (u, o) => u.includes(':/content') && o.method === 'PUT',
    reply: () => reply(507, null, 'Insufficient storage')
  });
  threw = '';
  try { await sp.upload(small, now); } catch (e) { threw = e.message; }
  t('a rejected upload is reported with its status', /Upload failed: 507/.test(threw), threw);

  console.log('\n--- 8. a folder override is honoured ---');
  process.env.BACKUP_SP_FOLDER = '/Estimating/DB Backups/';
  sp = loadSp();
  t('leading and trailing slashes trimmed', sp.itemPathFor(now).startsWith('Estimating/DB Backups/2026/09/03/'), sp.itemPathFor(now));

  console.log('\n--- 9. the shared timer picks SharePoint over S3 ---');
  process.env.BACKUP_S3_ENDPOINT = 'http://127.0.0.1:1';
  process.env.BACKUP_S3_BUCKET = 'b';
  process.env.BACKUP_S3_KEY_ID = 'k';
  process.env.BACKUP_S3_SECRET = 's';
  delete require.cache[require.resolve('../lib/offsite_backup')];
  delete require.cache[require.resolve('../lib/offsite_sharepoint')];
  const ob = require('../lib/offsite_backup');
  t('both configured', ob.isConfigured() === true && ob.s3Configured() === true);
  t('SharePoint wins', ob.destination() === 'sharepoint', ob.destination());

  graphOk();
  calls.length = 0;
  const db = require('../db');
  db.exec("INSERT INTO estimates (id,project_name,bid_number,client_gc,status,is_alternate) VALUES (1,'Maple St','1234','Turner','Submitted',0)");
  await ob.runOnce(db);
  t('a real snapshot was pushed to SharePoint', ob.state.lastSuccessAt !== null, ob.state);
  t('no error recorded', ob.state.lastError === null, ob.state.lastError);
  t('state names the destination', ob.start(db).destination === 'sharepoint', ob.state.destination);
  const spPut = calls.find(c => c.opts.method === 'PUT' && c.url.includes(':/content'));
  t('and the bytes are a real SQLite file', spPut.opts.body.slice(0, 15).toString() === 'SQLite format 3', spPut.opts.body.slice(0, 15).toString());

  console.log('\n--- 10. a SharePoint failure is recorded loudly ---');
  resetRoutes();
  routes.push({ match: () => true, reply: () => reply(500, null, 'boom') });
  delete require.cache[require.resolve('../lib/offsite_sharepoint')];
  await ob.runOnce(db);
  t('failure recorded', !!ob.state.lastError, ob.state.lastError);
  t('failure counted', ob.state.consecutiveFailures >= 1, ob.state.consecutiveFailures);

  global.fetch = realFetch;
  console.log('\n' + (fail ? 'FAILURES: ' + fail + ' / ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASSED'));
  process.exit(fail ? 1 : 0);
})();

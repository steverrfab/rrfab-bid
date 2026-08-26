// Off-site backup: signing shape, a real upload against a stand-in bucket, and
// the failure path. Cannot test against Cloudflare from here, so this proves
// everything up to the wire and that failures are recorded loudly.
const os=require('os'), fs=require('fs'), p=require('path'), http=require('http');
process.env.DATA_DIR = fs.mkdtempSync(p.join(os.tmpdir(),'ob-'));

let received = null, replyStatus = 200;
const bucket = http.createServer((req, res) => {
  const chunks=[];
  req.on('data',c=>chunks.push(c));
  req.on('end',()=>{
    received = { method:req.method, url:req.url, headers:req.headers, body:Buffer.concat(chunks) };
    res.writeHead(replyStatus); res.end(replyStatus===200?'':'denied');
  });
});
let pass=0,fail=0;
const t=(n,c,x)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+' -> '+JSON.stringify(x)));};

bucket.listen(4633, async () => {
  // Unconfigured first: must be a complete no-op.
  let ob = require('../lib/offsite_backup');
  t('no-op when unconfigured', ob.isConfigured()===false, ob.CFG);
  t('start() reports not configured', ob.start(require('../db')).configured===false);

  // Now configure and reload the module so it picks the env up.
  process.env.BACKUP_S3_ENDPOINT='http://127.0.0.1:4633';
  process.env.BACKUP_S3_BUCKET='rrfab-bid-backups';
  process.env.BACKUP_S3_KEY_ID='TESTKEYID';
  process.env.BACKUP_S3_SECRET='TESTSECRET';
  delete require.cache[require.resolve('../lib/offsite_backup')];
  ob = require('../lib/offsite_backup');
  const db = require('../db');
  db.exec("INSERT INTO estimates (id,project_name,bid_number,client_gc,status,is_alternate) VALUES (1,'Maple St','1234','Turner','Submitted',0)");

  t('configured now', ob.isConfigured()===true);
  await ob.runOnce(db);

  t('uploaded', !!received, received);
  t('used PUT', received.method==='PUT', received.method);
  t('path is bucket + dated key', /^\/rrfab-bid-backups\/rrbid\/\d{4}\/\d{2}\/\d{2}\/rrbid-.*\.db$/.test(received.url), received.url);
  t('signed with SigV4', /^AWS4-HMAC-SHA256 Credential=TESTKEYID\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/.test(received.headers.authorization), received.headers.authorization);
  t('content hash header set', /^[0-9a-f]{64}$/.test(received.headers['x-amz-content-sha256']));
  t('body is a real SQLite file', received.body.slice(0,15).toString()==='SQLite format 3', received.body.slice(0,15).toString());

  // The uploaded bytes must actually open and contain the bid.
  const out = p.join(os.tmpdir(),'ob-restored-'+Date.now()+'.db');
  fs.writeFileSync(out, received.body);
  const Database=require('better-sqlite3'); const r2=new Database(out);
  t('uploaded copy opens with the bid in it', r2.prepare('SELECT bid_number FROM estimates').get().bid_number==='1234');

  t('success recorded', !!ob.state.lastSuccessAt && ob.state.lastError===null && ob.state.consecutiveFailures===0, ob.state);

  // Failure path.
  replyStatus = 403;
  await ob.runOnce(db);
  t('failure recorded, not swallowed', ob.state.lastError && /403/.test(ob.state.lastError), ob.state.lastError);
  t('failure counter climbs', ob.state.consecutiveFailures===1, ob.state.consecutiveFailures);
  replyStatus = 200;
  await ob.runOnce(db);
  t('recovers and resets the counter', ob.state.consecutiveFailures===0 && ob.state.lastError===null, ob.state);

  await new Promise(r=>setTimeout(r,200));
  const strays = fs.readdirSync(os.tmpdir()).filter(f=>f.startsWith('rrbid-offsite-'));
  t('no temp files left behind', strays.length===0, strays);

  console.log('\n' + (fail? 'FAILURES: '+fail : 'ALL '+pass+' CHECKS PASSED'));
  bucket.close(); process.exit(fail?1:0);
});

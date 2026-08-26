// Backup endpoint: the key checks, and a real round trip that writes the
// downloaded snapshot to disk, reopens it, and confirms the bids are in it.
// A backup nobody has restored is not a backup.
const os=require('os'), fsx=require('fs'), px=require('path');
process.env.DATA_DIR = fsx.mkdtempSync(px.join(os.tmpdir(),'bk-'));
process.env.BACKUP_KEY = 'correct-horse-battery-staple-9f3a';
const express=require('express'); const db=require('../db');
db.exec("INSERT INTO users (id,email,name,role,active) VALUES (7,'a@x.t','A','admin',1)");
db.exec("INSERT INTO estimates (id,project_name,bid_number,client_gc,status,created_by,is_alternate) VALUES (1,'Maple St','1234','Turner','Submitted',7,0)");
const app=express(); app.use(express.json());
app.use('/api/backup', require('../routes/backup'));
const srv=app.listen(4611, run);
const B='http://127.0.0.1:4611/api/backup';
let pass=0,fail=0; const t=(n,c,x)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+' -> '+JSON.stringify(x)));};
async function run(){
  let r = await fetch(B+'/db'); t('no key is refused', r.status===401, r.status);
  r = await fetch(B+'/db',{headers:{'X-Integration-Key':'wrong'}}); t('wrong key refused', r.status===401, r.status);
  r = await fetch(B+'/db',{headers:{'X-Integration-Key':'correct-horse-battery-staple-9f3'}}); t('near-miss key refused', r.status===401, r.status);
  r = await fetch(B+'/status',{headers:{'X-Integration-Key':process.env.BACKUP_KEY}});
  const s = await r.json(); t('status works with key', r.status===200 && s.counts.estimates===1, s);

  r = await fetch(B+'/db',{headers:{'X-Integration-Key':process.env.BACKUP_KEY}});
  t('download works with key', r.status===200, r.status);
  t('sent as a file', /attachment; filename="rrbid-/.test(r.headers.get('content-disposition')), r.headers.get('content-disposition'));
  const buf = Buffer.from(await r.arrayBuffer());
  t('looks like a SQLite file', buf.slice(0,15).toString()==='SQLite format 3', buf.slice(0,15).toString());

  // The real test: the snapshot must open and hold the same rows.
  const out = px.join(os.tmpdir(),'restored-'+Date.now()+'.db');
  fsx.writeFileSync(out, buf);
  const Database=require('better-sqlite3'); const r2=new Database(out);
  const est = r2.prepare('SELECT project_name, bid_number FROM estimates').all();
  t('restored copy opens and has the bid', est.length===1 && est[0].bid_number==='1234', est);
  const tables = r2.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n;
  t('restored copy has the full schema', tables > 15, tables);

  // No temp files left lying around.
  const leftover = fsx.readdirSync(os.tmpdir()).filter(f=>f.startsWith('rrbid-backup-'));
  t('temp snapshot cleaned up', leftover.length===0, leftover);

  console.log('\n' + (fail? 'FAILURES: '+fail : 'ALL '+pass+' CHECKS PASSED'));
  srv.close(); process.exit(fail?1:0);
}

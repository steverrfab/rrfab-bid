'use strict';
// Continuous off-site backup.
//
// The whole company's estimating history is one small SQLite file on one Railway
// volume, and the Railway plan in use allows no volume backups. This pushes a
// fresh copy of that file to S3-compatible object storage on a timer, so a lost
// volume costs at most one interval of work instead of everything.
//
// The database is about 1.5 MB. Copying all of it every time is simpler and far
// easier to reason about than streaming changes, and at this size the cost of
// doing so is negligible.
//
// Configure with Railway variables. With any of the first four missing this
// module does nothing at all and says so once in the log:
//   BACKUP_S3_ENDPOINT   e.g. https://<accountid>.r2.cloudflarestorage.com
//   BACKUP_S3_BUCKET     e.g. rrfab-bid-backups
//   BACKUP_S3_KEY_ID     access key id
//   BACKUP_S3_SECRET     secret access key
//   BACKUP_INTERVAL_MIN  optional, default 60
//
// Old copies are not pruned here. Set a lifecycle rule on the bucket instead:
// it is the storage provider's job, it cannot be broken by a bug in this file,
// and a bug here that deletes backups is precisely the thing worth avoiding.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CFG = {
  endpoint: process.env.BACKUP_S3_ENDPOINT || '',
  bucket: process.env.BACKUP_S3_BUCKET || '',
  keyId: process.env.BACKUP_S3_KEY_ID || '',
  secret: process.env.BACKUP_S3_SECRET || '',
  intervalMin: Math.max(5, parseInt(process.env.BACKUP_INTERVAL_MIN || '60', 10) || 60)
};

// Reported by /api/backup/status so a silent failure is visible rather than
// assumed away. A backup you believe is running and is not is worse than none.
const state = {
  configured: false,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastKey: null,
  lastBytes: null,
  lastError: null,
  consecutiveFailures: 0
};

function isConfigured() {
  return !!(CFG.endpoint && CFG.bucket && CFG.keyId && CFG.secret);
}

// ---- Minimal SigV4 PUT ----
// Hand-rolled rather than pulling in the AWS SDK: one request shape, no
// streaming, no retries beyond the timer itself. Signing is mechanical, and
// keeping it here means the whole backup path is readable in one file.
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();

function signedHeaders({ method, url, body, region }) {
  const u = new URL(url);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body);

  const canonicalHeaders =
    'host:' + u.host + '\n' +
    'x-amz-content-sha256:' + payloadHash + '\n' +
    'x-amz-date:' + amzDate + '\n';
  const signedHdrs = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [
    method,
    u.pathname,
    '',                       // no query string
    canonicalHeaders,
    signedHdrs,
    payloadHash
  ].join('\n');

  const scope = [dateStamp, region, 's3', 'aws4_request'].join('/');
  const toSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256(Buffer.from(canonicalRequest, 'utf8'))
  ].join('\n');

  let k = hmac('AWS4' + CFG.secret, dateStamp);
  k = hmac(k, region);
  k = hmac(k, 's3');
  k = hmac(k, 'aws4_request');
  const signature = crypto.createHmac('sha256', k).update(toSign).digest('hex');

  return {
    Authorization: 'AWS4-HMAC-SHA256 Credential=' + CFG.keyId + '/' + scope +
      ', SignedHeaders=' + signedHdrs + ', Signature=' + signature,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    'Content-Length': String(body.length),
    'Content-Type': 'application/octet-stream'
  };
}

// Sorted by date so the newest is last, and one folder per day so a human
// browsing the bucket can find a given day without scrolling past thousands.
function objectKey(now) {
  const iso = now.toISOString().replace(/[:.]/g, '-');
  return [
    'rrbid',
    now.toISOString().slice(0, 4),
    now.toISOString().slice(5, 7),
    now.toISOString().slice(8, 10),
    'rrbid-' + iso + '.db'
  ].join('/');
}

async function runOnce(db) {
  state.lastAttemptAt = new Date().toISOString();
  const tmp = path.join(os.tmpdir(), 'rrbid-offsite-' + crypto.randomBytes(6).toString('hex') + '.db');
  try {
    // Same reasoning as the download endpoint: the database is in WAL mode, so
    // the newest commits are not in the main file yet and a plain copy can come
    // back torn. VACUUM INTO writes a complete, checkpointed, compacted copy
    // while the app carries on serving.
    db.prepare('VACUUM INTO ?').run(tmp);
    const body = fs.readFileSync(tmp);

    const now = new Date();
    const key = objectKey(now);
    const url = CFG.endpoint.replace(/\/+$/, '') + '/' + CFG.bucket + '/' + key;
    // R2 ignores region but SigV4 requires one in the scope; "auto" is what
    // Cloudflare documents. Real S3 needs its own, so allow an override.
    const region = process.env.BACKUP_S3_REGION || 'auto';

    const res = await fetch(url, {
      method: 'PUT',
      headers: signedHeaders({ method: 'PUT', url, body, region }),
      body
    });

    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new Error('HTTP ' + res.status + ' ' + text);
    }

    state.lastSuccessAt = new Date().toISOString();
    state.lastKey = key;
    state.lastBytes = body.length;
    state.lastError = null;
    state.consecutiveFailures = 0;
    console.log('[offsite] backed up ' + body.length + ' bytes to ' + CFG.bucket + '/' + key);
  } catch (err) {
    state.lastError = err.message;
    state.consecutiveFailures += 1;
    // Loud on purpose. A backup that has quietly stopped working is the failure
    // mode that actually costs people their data.
    console.error('[offsite] BACKUP FAILED (' + state.consecutiveFailures +
      ' in a row): ' + err.message);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}

function start(db) {
  state.configured = isConfigured();
  if (!state.configured) {
    console.log('[offsite] off-site backup is NOT configured. ' +
      'Set BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_KEY_ID and BACKUP_S3_SECRET ' +
      'to switch it on. The database is currently backed up nowhere.');
    return state;
  }
  console.log('[offsite] off-site backup on, every ' + CFG.intervalMin + ' minute(s) to ' + CFG.bucket);
  // A first run shortly after boot, so a broken configuration is discovered now
  // rather than an hour from now, but not so soon that it fights startup.
  setTimeout(() => runOnce(db), 30 * 1000).unref?.();
  setInterval(() => runOnce(db), CFG.intervalMin * 60 * 1000).unref?.();
  return state;
}

module.exports = { start, runOnce, state, isConfigured, objectKey, signedHeaders, CFG };

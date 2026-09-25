'use strict';
// Independent nightly B2 copies. The existing hourly SharePoint job is unchanged.
// No delete operations and no schema/data migrations belong in this module.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { promisify } = require('util');
const gzip = promisify(require('zlib').gzip);
const gunzip = promisify(require('zlib').gunzip);
const Database = require('better-sqlite3');
const DAY = 24 * 60 * 60 * 1000;
const MAX_BYTES = 128 * 1024 * 1024;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();

class BackupError extends Error {}
const fail = message => { throw new BackupError(message); };

function configFromEnv(env = process.env) {
  return {
    enabled: env.B2_BACKUP_ENABLED === 'true',
    endpoint: env.B2_BACKUP_ENDPOINT || '',
    region: env.B2_BACKUP_REGION || '',
    bucket: env.B2_BACKUP_BUCKET || '',
    prefix: env.B2_BACKUP_PREFIX || 'projects/rrfab-bid/',
    keyId: env.B2_BACKUP_KEY_ID || '',
    secret: env.B2_BACKUP_SECRET || '',
    utcTime: env.B2_BACKUP_UTC_TIME || '06:17',
    alertTo: env.B2_BACKUP_ALERT_TO || '',
    dataDir: env.DATA_DIR || path.join(__dirname, '..', 'data')
  };
}

function validate(config) {
  if (!config.keyId || !config.secret) fail('B2 application key is not configured');
  if (!/^[a-z0-9-]+$/.test(config.region) ||
      config.endpoint !== `https://s3.${config.region}.backblazeb2.com`) {
    fail('B2 endpoint must match its HTTPS region endpoint');
  }
  if (!/^[a-z0-9][a-z0-9-]{4,61}[a-z0-9]$/.test(config.bucket)) fail('Invalid B2 bucket');
  if (!/^projects\/[a-z0-9_-]+\/$/.test(config.prefix)) fail('Use a project-specific B2 prefix');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(config.utcTime)) fail('B2 time must be HH:MM in UTC');
  if (config.alertTo && !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(config.alertTo)) {
    fail('Configure one approved backup alert email address');
  }
}

// A missed night's run is caught up when the service resumes. Monday starts a
// weekly period; the first successful run also establishes all three tiers.
function periodsAt(now, utcTime) {
  const due = new Date(now);
  const [hour, minute] = utcTime.split(':').map(Number);
  due.setUTCHours(hour, minute, 0, 0);
  if (due > now) due.setUTCDate(due.getUTCDate() - 1);
  const daily = due.toISOString().slice(0, 10);
  const monthly = daily.slice(0, 7);
  due.setUTCDate(due.getUTCDate() - (due.getUTCDay() + 6) % 7);
  return { daily, weekly: due.toISOString().slice(0, 10), monthly };
}

function signedHeaders(config, method, url, body, now) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const u = new URL(url);
  const headers = {
    host: u.host,
    'x-amz-content-sha256': sha256(body),
    'x-amz-date': amzDate
  };
  if (method === 'PUT') headers['x-amz-server-side-encryption'] = 'AES256';
  const names = Object.keys(headers).sort();
  const canonical = [method, u.pathname, '',
    names.map(name => name + ':' + headers[name] + '\n').join(''),
    names.join(';'), sha256(body)].join('\n');
  const scope = `${date}/${config.region}/s3/aws4_request`;
  let key = hmac('AWS4' + config.secret, date);
  key = hmac(key, config.region);
  key = hmac(key, 's3');
  key = hmac(key, 'aws4_request');
  headers.Authorization = `AWS4-HMAC-SHA256 Credential=${config.keyId}/${scope}, ` +
    `SignedHeaders=${names.join(';')}, Signature=` +
    hmac(key, ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')).toString('hex');
  if (method === 'PUT') {
    headers['Content-Length'] = String(body.length);
    headers['Content-Type'] = 'application/octet-stream';
  }
  return headers;
}

function inspectDatabase(filename) {
  // Open the copy directly. Importing db.js here would execute migrations.
  const copy = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    const integrity = copy.pragma('integrity_check');
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      fail('SQLite integrity check failed');
    }
    const counts = {};
    const tables = copy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    for (const { name } of tables) {
      counts[name] = copy.prepare('SELECT COUNT(*) AS n FROM "' + name.replace(/"/g, '""') + '"').get().n;
    }
    for (const required of ['estimates', 'change_orders', 'users']) {
      if (!(required in counts)) fail('Backup is missing a required bid database table');
    }
    return { integrityCheck: 'ok', userVersion: copy.pragma('user_version', { simple: true }), tableRowCounts: counts };
  } finally {
    copy.close();
  }
}

function createBackup({ config = configFromEnv(), fetchImpl = fetch, now = () => new Date(),
  retryDelayMs = 1000, notify = (to, details) => require('./email').sendBackupNotification(to, details) } = {}) {
  const state = {
    enabled: config.enabled, configured: false, running: false, scheduleUtc: config.utcTime,
    lastAttemptAt: null, lastSuccessAt: null, lastVerifiedAt: null, lastError: null,
    consecutiveFailures: 0, completedPeriods: {}, lastObjects: [],
    lastFailureAlertAt: null, lastRecoveryAlertAt: null, lastAlertError: null
  };
  const stateFile = path.join(config.dataDir, 'b2-backup-state.json');
  const destination = [config.endpoint, config.bucket, config.prefix].join('/');
  let loaded = false, timer, firstTimer;

  function loadState() {
    if (loaded) return;
    loaded = true;
    try {
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (saved.destination !== destination) return;
      for (const key of ['lastAttemptAt', 'lastSuccessAt', 'lastVerifiedAt', 'lastFailureAlertAt', 'lastRecoveryAlertAt']) {
        if (saved[key] && Number.isFinite(Date.parse(saved[key]))) state[key] = saved[key];
      }
      if (saved.completedPeriods && typeof saved.completedPeriods === 'object') state.completedPeriods = saved.completedPeriods;
      if (Array.isArray(saved.lastObjects)) state.lastObjects = saved.lastObjects;
      state.consecutiveFailures = Math.max(0, Number(saved.consecutiveFailures) || 0);
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[b2-backup] Schedule state unavailable; a fresh verified copy will be made');
    }
  }

  function saveState(value = state) {
    const tmp = stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ ...value, destination, running: false }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, stateFile);
  }

  async function request(method, key, body = Buffer.alloc(0), limit = MAX_BYTES) {
    const url = config.endpoint + '/' + config.bucket + '/' + key;
    for (let attempt = 0; attempt < 3; attempt++) {
      let retry = true;
      try {
        const response = await fetchImpl(url, {
          method, headers: signedHeaders(config, method, url, body, now()),
          body: method === 'PUT' ? body : undefined,
          redirect: 'error', signal: AbortSignal.timeout(30000)
        });
        if (!response.ok) {
          await response.body?.cancel();
          retry = response.status === 408 || response.status === 429 || response.status >= 500;
          fail(`B2 ${method} returned HTTP ${response.status}`);
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body || []) {
          size += chunk.length;
          if (size > limit) { retry = false; fail('B2 response exceeded the expected size'); }
          chunks.push(chunk);
        }
        return Buffer.concat(chunks);
      } catch (err) {
        if (!retry || attempt === 2) {
          // Never include provider response bodies, signed URLs or credentials.
          throw err instanceof BackupError ? err : new BackupError(`B2 ${method} network request failed or timed out`);
        }
        await new Promise(resolve => setTimeout(resolve, retryDelayMs * (2 ** attempt)));
      }
    }
  }

  async function alert(kind) {
    if (!config.alertTo) return;
    const last = kind === 'failure' ? state.lastFailureAlertAt : state.lastRecoveryAlertAt;
    if (last && now() - new Date(last) < DAY) return;
    try {
      const result = await notify(config.alertTo, {
        kind, lastSuccessAt: state.lastSuccessAt, lastError: state.lastError
      });
      if (!result?.ok) fail('Backup alert email could not be sent');
      state[kind === 'failure' ? 'lastFailureAlertAt' : 'lastRecoveryAlertAt'] = now().toISOString();
      state.lastAlertError = null;
    } catch {
      state.lastAlertError = 'Backup alert email could not be sent';
      console.error('[b2-backup] ' + state.lastAlertError);
    }
    try { saveState(); } catch { console.error('[b2-backup] Could not persist alert status'); }
  }

  async function runOnce(db, { force = false } = {}) {
    if (!config.enabled || state.running) return { skipped: true };
    loadState();
    const at = now();
    const periods = periodsAt(at, /^([01]\d|2[0-3]):[0-5]\d$/.test(config.utcTime) ? config.utcTime : '06:17');
    const tiers = Object.keys(periods).filter(tier => state.completedPeriods[tier] !== periods[tier]);
    if (!force && tiers.length === 0) return { skipped: true };
    if (!force && state.consecutiveFailures && state.lastAttemptAt && at - new Date(state.lastAttemptAt) < 15 * 60 * 1000) {
      return { skipped: true };
    }
    if (!tiers.includes('daily')) tiers.unshift('daily');
    state.running = true;
    state.lastAttemptAt = at.toISOString();
    let tempDir;
    try {
      validate(config);
      state.configured = true;
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rrbid-b2-'));
      const snapshot = path.join(tempDir, 'snapshot.db');
      // SQLite's online backup includes committed WAL data without copying a
      // live file or holding a write lock for compression/network requests.
      await db.backup(snapshot);
      if (fs.statSync(snapshot).size > MAX_BYTES) fail('Database exceeds the 128 MiB backup size limit; review capacity');
      const summary = inspectDatabase(snapshot);
      const raw = fs.readFileSync(snapshot);
      const archive = await gzip(raw);
      const stamp = at.toISOString().replace(/[:.]/g, '-');
      const objects = [];
      for (const tier of tiers) {
        const key = `${config.prefix}database/${tier}/rrfab-bid_${stamp}.db.gz`;
        await request('PUT', key, archive);
        const downloaded = await request('GET', key, undefined, archive.length);
        if (sha256(downloaded) !== sha256(archive)) fail('Downloaded backup checksum did not match');
        const restored = await gunzip(downloaded, { maxOutputLength: MAX_BYTES });
        if (sha256(restored) !== sha256(raw)) fail('Restored database checksum did not match');
        const restoredPath = path.join(tempDir, 'restored-' + tier + '.db');
        fs.writeFileSync(restoredPath, restored, { mode: 0o600 });
        if (JSON.stringify(inspectDatabase(restoredPath)) !== JSON.stringify(summary)) fail('Restored database validation did not match');
        const manifest = Buffer.from(JSON.stringify({
          format: 'rrfab-bid-sqlite-gzip-v1', objectKey: key, tier, period: periods[tier],
          snapshotStartedAt: at.toISOString(), verifiedAt: now().toISOString(),
          archiveBytes: archive.length, databaseBytes: raw.length,
          archiveSha256: sha256(archive), databaseSha256: sha256(raw), ...summary
        }, null, 2) + '\n');
        const manifestKey = key.replace(/\.db\.gz$/, '.manifest.json');
        await request('PUT', manifestKey, manifest);
        const savedManifest = await request('GET', manifestKey, undefined, manifest.length);
        if (sha256(savedManifest) !== sha256(manifest)) fail('Downloaded backup manifest did not match');
        objects.push({ key, manifestKey, archiveBytes: archive.length, archiveSha256: sha256(archive) });
      }
      const verifiedAt = now().toISOString();
      const completed = { ...state, lastSuccessAt: verifiedAt, lastVerifiedAt: verifiedAt,
        completedPeriods: periods, lastObjects: objects, lastError: null, consecutiveFailures: 0 };
      saveState(completed);
      Object.assign(state, completed);
      console.log(`[b2-backup] VERIFIED ${objects.length} copy/copies; ${archive.length} compressed bytes each; ${objects[0].key}`);
      if (state.lastFailureAlertAt && (!state.lastRecoveryAlertAt || state.lastFailureAlertAt > state.lastRecoveryAlertAt)) await alert('recovery');
      return { ok: true, objects };
    } catch (err) {
      state.lastError = err instanceof BackupError ? err.message : 'Local snapshot, restore validation or schedule-state save failed';
      state.consecutiveFailures++;
      console.error(`[b2-backup] BACKUP FAILED (${state.consecutiveFailures}): ${state.lastError}`);
      try { saveState(); } catch { /* failure is already visible in logs/status */ }
      await alert('failure');
      return { ok: false, error: state.lastError };
    } finally {
      state.running = false;
      if (tempDir) {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); }
        catch { console.error('[b2-backup] Temporary snapshot cleanup failed'); }
      }
    }
  }

  function start(db) {
    if (!config.enabled || timer) return state;
    loadState();
    try { validate(config); state.configured = true; }
    catch { state.configured = false; }
    console.log('[b2-backup] Nightly backup enabled; schedule ' + config.utcTime + ' UTC');
    firstTimer = setTimeout(() => runOnce(db), 30000);
    timer = setInterval(() => runOnce(db), 60000);
    firstTimer.unref?.();
    timer.unref?.();
    return state;
  }
  function stop() { clearTimeout(firstTimer); clearInterval(timer); timer = null; }
  return { start, stop, runOnce, state };
}

const backup = createBackup();
module.exports = { ...backup, createBackup, configFromEnv, periodsAt, inspectDatabase, signedHeaders };

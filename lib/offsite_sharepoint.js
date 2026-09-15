'use strict';
// SharePoint destination for the off-site backup.
//
// The alternative to this is S3-compatible object storage (see offsite_backup.js).
// SharePoint is offered because the company already lives in Microsoft 365: the
// backups land in a document library alongside everything else, they can be
// opened from Explorer or the browser without another vendor account, and the
// app registration that sends proposal email already exists, so there are no new
// credentials to look after.
//
// Authentication is app-only (client credentials), deliberately. A delegated
// user token has to be refreshed and eventually stops working without anyone
// noticing, which is the exact failure mode a backup must not have. The app signs
// in as itself, and nothing expires.
//
// Configure with Railway variables:
//   BACKUP_SP_SITE     required. The site, as hostname:/sites/Name
//                      e.g. rrfabrication.sharepoint.com:/sites/Operations
//   BACKUP_SP_FOLDER   optional, default 'BidToolBackups'. Folder inside the
//                      site's default document library. Created if missing.
//   BACKUP_SP_LIBRARY  optional. Document library name, when it should go
//                      somewhere other than the site's default one.
// Plus the three that already exist for email:
//   AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
//
// The app needs Sites.Selected (granted on this one site) or Sites.ReadWrite.All.
//
// Old copies are not pruned here, for the same reason they are not pruned in the
// S3 path: a bug in delete code is precisely the thing worth avoiding. Use a
// retention policy on the library instead.

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

// Graph refuses a plain content PUT above 4 MB and wants a resumable session.
// The database is well under that today, but it only ever grows, so the larger
// path is implemented rather than left as a surprise for later.
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;
const CHUNK = 5 * 320 * 1024;   // 1.6 MB; Graph requires a multiple of 320 KiB

const CFG = {
  site: process.env.BACKUP_SP_SITE || '',
  folder: (process.env.BACKUP_SP_FOLDER || 'BidToolBackups').replace(/^\/+|\/+$/g, ''),
  library: process.env.BACKUP_SP_LIBRARY || '',
  tenant: process.env.AZURE_TENANT_ID || '',
  clientId: process.env.AZURE_CLIENT_ID || '',
  clientSecret: process.env.AZURE_CLIENT_SECRET || ''
};

function isConfigured() {
  return !!(CFG.site && CFG.tenant && CFG.clientId && CFG.clientSecret);
}

// What is missing, in words, so a half-configured deploy says which variable to
// set rather than just failing.
function missingConfig() {
  const missing = [];
  if (!CFG.site) missing.push('BACKUP_SP_SITE');
  if (!CFG.tenant) missing.push('AZURE_TENANT_ID');
  if (!CFG.clientId) missing.push('AZURE_CLIENT_ID');
  if (!CFG.clientSecret) missing.push('AZURE_CLIENT_SECRET');
  return missing;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms))
  ]);
}

// ---- Token ----
// Cached for its lifetime, same as lib/email.js. Kept separate from that cache
// on purpose: backup must not be able to break email by clearing a shared one.
let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getToken() {
  const now = Date.now();
  if (cachedToken && cachedTokenExpiresAt > now + 60000) return cachedToken;
  const url = 'https://login.microsoftonline.com/' + CFG.tenant + '/oauth2/v2.0/token';
  const body = new URLSearchParams({
    client_id: CFG.clientId,
    client_secret: CFG.clientSecret,
    scope: GRAPH_SCOPE,
    grant_type: 'client_credentials'
  }).toString();
  const res = await withTimeout(
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }),
    20000, 'OAuth token request'
  );
  if (!res.ok) {
    throw new Error('Token request failed: ' + res.status + ' ' + (await res.text()).slice(0, 300));
  }
  const data = await res.json();
  cachedToken = data.access_token;
  cachedTokenExpiresAt = now + ((data.expires_in || 3600) * 1000);
  return cachedToken;
}

// Exported so a test can clear it between cases.
function _resetTokenCache() { cachedToken = null; cachedTokenExpiresAt = 0; }

async function graph(pathOrUrl, opts = {}) {
  const token = await getToken();
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : GRAPH_BASE + pathOrUrl;
  const res = await withTimeout(
    fetch(url, {
      ...opts,
      headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) }
    }),
    120000, 'Graph request'
  );
  return res;
}

// ---- Site and drive resolution ----
// Both are stable for the life of the process, so they are looked up once and
// remembered. A redeploy re-resolves them, which is often enough to pick up a
// library that has been moved or renamed.
let cachedDriveId = null;
let cachedSiteId = null;

async function resolveDriveId() {
  if (cachedDriveId) return cachedDriveId;

  // Graph addresses a site as {hostname}:/{server-relative-path}. Anything the
  // user typed with a scheme or a trailing slash is tidied up rather than
  // rejected, because that is the shape people copy out of the address bar.
  const site = CFG.site.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const siteRes = await graph('/sites/' + site);
  if (!siteRes.ok) {
    throw new Error('Could not find the SharePoint site "' + CFG.site + '": ' +
      siteRes.status + ' ' + (await siteRes.text()).slice(0, 300));
  }
  const siteId = (await siteRes.json()).id;

  if (!CFG.library) {
    cachedDriveId = null;   // default library, addressed as /sites/{id}/drive
    cachedSiteId = siteId;
    return null;
  }

  const drivesRes = await graph('/sites/' + siteId + '/drives');
  if (!drivesRes.ok) {
    throw new Error('Could not list the document libraries: ' + drivesRes.status);
  }
  const drives = (await drivesRes.json()).value || [];
  const want = CFG.library.toLowerCase();
  const hit = drives.find(d => String(d.name || '').toLowerCase() === want);
  if (!hit) {
    throw new Error('No document library named "' + CFG.library + '" on that site. Found: ' +
      drives.map(d => d.name).join(', '));
  }
  cachedSiteId = siteId;
  cachedDriveId = hit.id;
  return hit.id;
}

// The root of wherever we are writing, as a Graph path prefix.
function driveRoot() {
  return cachedDriveId
    ? '/drives/' + cachedDriveId
    : '/sites/' + cachedSiteId + '/drive';
}

// ---- Upload ----
async function simpleUpload(itemPath, body) {
  const res = await graph(driveRoot() + '/root:/' + itemPath + ':/content', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body
  });
  if (!res.ok) {
    throw new Error('Upload failed: ' + res.status + ' ' + (await res.text()).slice(0, 300));
  }
  return res.json();
}

async function sessionUpload(itemPath, body) {
  const createRes = await graph(driveRoot() + '/root:/' + itemPath + ':/createUploadSession', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } })
  });
  if (!createRes.ok) {
    throw new Error('Could not start the upload session: ' + createRes.status + ' ' +
      (await createRes.text()).slice(0, 300));
  }
  const { uploadUrl } = await createRes.json();

  let start = 0;
  let last = null;
  while (start < body.length) {
    const end = Math.min(start + CHUNK, body.length);
    const slice = body.subarray(start, end);
    // The upload URL carries its own auth, so no bearer token here.
    const res = await withTimeout(fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(slice.length),
        'Content-Range': 'bytes ' + start + '-' + (end - 1) + '/' + body.length
      },
      body: slice
    }), 120000, 'Chunk upload');
    if (!res.ok && res.status !== 202) {
      throw new Error('Chunk ' + start + '-' + (end - 1) + ' failed: ' + res.status + ' ' +
        (await res.text()).slice(0, 200));
    }
    if (res.status !== 202) last = await res.json();
    start = end;
  }
  return last;
}

// Sorted by date so the newest is last, and one folder per day, matching the
// layout the S3 path uses so the two are interchangeable to a human.
function itemPathFor(now) {
  const iso = now.toISOString().replace(/[:.]/g, '-');
  const parts = [
    now.toISOString().slice(0, 4),
    now.toISOString().slice(5, 7),
    now.toISOString().slice(8, 10),
    'rrbid-' + iso + '.db'
  ];
  return (CFG.folder ? CFG.folder + '/' : '') + parts.join('/');
}

// Uploads one snapshot. Returns { path, bytes }. Throws on any failure, so the
// caller records it and shouts; nothing here swallows an error.
async function upload(body, now = new Date()) {
  if (!isConfigured()) {
    throw new Error('SharePoint backup is not configured. Missing: ' + missingConfig().join(', '));
  }
  await resolveDriveId();
  const itemPath = itemPathFor(now);
  if (body.length <= SIMPLE_UPLOAD_LIMIT) {
    await simpleUpload(itemPath, body);
  } else {
    await sessionUpload(itemPath, body);
  }
  return { path: itemPath, bytes: body.length };
}

module.exports = {
  CFG,
  isConfigured,
  missingConfig,
  itemPathFor,
  upload,
  resolveDriveId,
  SIMPLE_UPLOAD_LIMIT,
  _resetTokenCache,
  _setCaches: (siteId, driveId) => { cachedSiteId = siteId; cachedDriveId = driveId; }
};

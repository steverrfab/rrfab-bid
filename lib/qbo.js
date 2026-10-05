'use strict';
// QuickBooks Online client. Everything that talks to Intuit lives here so the
// routes stay plain and a QuickBooks problem can never break bidding.
//
// Railway env vars on the bid service:
//   QBO_CLIENT_ID, QBO_CLIENT_SECRET  from the Intuit developer app
//   QBO_ENV                           'sandbox' or 'production' (default sandbox)
//   QBO_REDIRECT_URI                  must match the Redirect URI on the Intuit app,
//                                     e.g. https://rrfab-bid-production.up.railway.app/api/qbo/callback
//   QBO_APP_RETURN_URL                where the browser lands after connecting,
//                                     e.g. https://bid.rrfabrication.org/#/quickbooks
//
// Tokens: an access token lasts an hour, a refresh token about 100 days and it
// changes every time it is used, so the newest one is always saved straight away.
const db = require('../db');

const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
// The *_TEST_URL overrides exist only so test/qbo.test.js can point at a fake
// QuickBooks. They are never set on Railway.
const TOKEN_URL = process.env.QBO_TOKEN_TEST_URL || 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const PROJECT_SCOPE = 'project-management.project';
const SCOPES = ['com.intuit.quickbooks.accounting', PROJECT_SCOPE];
const MINOR = 75;

const isProd = () => String(process.env.QBO_ENV || 'sandbox').toLowerCase() === 'production';
const apiBase = () => process.env.QBO_API_TEST_URL || (isProd() ? 'https://quickbooks.api.intuit.com' : 'https://sandbox-quickbooks.api.intuit.com');
const gqlUrl = () => process.env.QBO_GRAPHQL_TEST_URL || (isProd() ? 'https://qb.api.intuit.com/graphql' : 'https://qb-sandbox.api.intuit.com/graphql');

function isConfigured() {
  return !!(process.env.QBO_CLIENT_ID && process.env.QBO_CLIENT_SECRET && process.env.QBO_REDIRECT_URI);
}

function basicAuth() {
  return 'Basic ' + Buffer.from(process.env.QBO_CLIENT_ID + ':' + process.env.QBO_CLIENT_SECRET).toString('base64');
}

function authorizeUrl(state) {
  const p = new URLSearchParams({
    client_id: process.env.QBO_CLIENT_ID,
    redirect_uri: process.env.QBO_REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
  });
  return AUTH_URL + '?' + p.toString();
}

async function tokenRequest(form) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: basicAuth(), Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('QuickBooks sign-in failed: ' + (body.error_description || body.error || r.status));
  return body;
}

const isoIn = (seconds) => new Date(Date.now() + (+seconds || 0) * 1000).toISOString();

function getConnection() {
  return db.prepare('SELECT * FROM qbo_connection WHERE id = 1').get() || null;
}

// Swap the one-time code from Intuit's redirect for tokens and save them.
async function exchangeCode(code, realmId, userId) {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: process.env.QBO_REDIRECT_URI });
  const hasProject = String(t.scope || '').split(/\s+/).includes(PROJECT_SCOPE) ? 1 : 0;
  const prev = getConnection();
  // Reconnecting to the same company keeps the controller's item choice.
  const keepItem = prev && prev.realm_id === String(realmId);
  db.prepare(`INSERT OR REPLACE INTO qbo_connection
      (id, realm_id, company_name, access_token, refresh_token, access_expires_at, refresh_expires_at,
       has_project_scope, item_id, item_name, connected_by, connected_at)
    VALUES (1, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(
    String(realmId), t.access_token, t.refresh_token, isoIn(t.expires_in),
    isoIn(t.x_refresh_token_expires_in), hasProject,
    keepItem ? prev.item_id : null, keepItem ? prev.item_name : null, userId || null);
  try {
    const info = await qboGet('/companyinfo/' + encodeURIComponent(realmId));
    const name = info && info.CompanyInfo && info.CompanyInfo.CompanyName;
    if (name) db.prepare('UPDATE qbo_connection SET company_name = ? WHERE id = 1').run(name);
  } catch (err) {
    console.error('[qbo] company name lookup failed:', err.message);
  }
}

// A valid access token, refreshing it first when it is within 5 minutes of expiring.
async function accessToken() {
  const c = getConnection();
  if (!c) throw new Error('QuickBooks is not connected. A controller needs to connect it first.');
  if (Date.parse(c.access_expires_at) - Date.now() > 5 * 60 * 1000) return c;
  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: c.refresh_token });
  db.prepare(`UPDATE qbo_connection SET access_token = ?, refresh_token = ?, access_expires_at = ?,
      refresh_expires_at = COALESCE(?, refresh_expires_at) WHERE id = 1`).run(
    t.access_token, t.refresh_token || c.refresh_token, isoIn(t.expires_in),
    t.x_refresh_token_expires_in ? isoIn(t.x_refresh_token_expires_in) : null);
  return getConnection();
}

async function disconnect() {
  const c = getConnection();
  if (c && isConfigured()) {
    try {
      await fetch(REVOKE_URL, {
        method: 'POST',
        headers: { Authorization: basicAuth(), Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: c.refresh_token }),
      });
    } catch (err) {
      console.error('[qbo] revoke failed (connection removed anyway):', err.message);
    }
  }
  db.prepare('DELETE FROM qbo_connection WHERE id = 1').run();
}

// Pull a readable message out of a QuickBooks error response.
function qbError(body, status) {
  const f = body && body.Fault && body.Fault.Error && body.Fault.Error[0];
  if (f) return (f.Message || 'QuickBooks error') + (f.Detail ? ': ' + f.Detail : '');
  return 'QuickBooks answered ' + status;
}

async function qboRequest(method, path, payload) {
  const c = await accessToken();
  const sep = path.includes('?') ? '&' : '?';
  const url = apiBase() + '/v3/company/' + encodeURIComponent(c.realm_id) + path + sep + 'minorversion=' + MINOR;
  const r = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + c.access_token, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(qbError(body, r.status));
    err.status = r.status;
    throw err;
  }
  return body;
}

const qboGet = (path) => qboRequest('GET', path);
const qboPost = (path, payload) => qboRequest('POST', path, payload);

// QuickBooks query language wants single quotes escaped with a backslash.
const q = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function query(sql) {
  const body = await qboGet('/query?query=' + encodeURIComponent(sql));
  return body.QueryResponse || {};
}

// Top-level customers (GCs) whose name contains the text. Projects and
// sub-customers are left out so the controller only sees real GCs.
async function searchCustomers(text) {
  const t = String(text || '').trim();
  const where = t ? ` WHERE DisplayName LIKE '%${q(t)}%'` : '';
  const res = await query(`SELECT Id, DisplayName, Job FROM Customer${where} MAXRESULTS 50`);
  return (res.Customer || []).filter(c => !c.Job).map(c => ({ id: c.Id, name: c.DisplayName }));
}

async function findCustomerByName(name) {
  const res = await query(`SELECT Id, DisplayName, Job FROM Customer WHERE DisplayName = '${q(name)}'`);
  const hit = (res.Customer || []).find(c => !c.Job);
  return hit ? { id: hit.Id, name: hit.DisplayName } : null;
}

async function createCustomer(name) {
  const body = await qboPost('/customer', { DisplayName: String(name).slice(0, 100) });
  return { id: body.Customer.Id, name: body.Customer.DisplayName };
}

async function listServiceItems() {
  const res = await query("SELECT Id, Name, Type FROM Item WHERE Active = true MAXRESULTS 500");
  return (res.Item || []).filter(i => i.Type === 'Service' || i.Type === 'NonInventory').map(i => ({ id: i.Id, name: i.Name }));
}

// A real QuickBooks Project under the GC, through Intuit's Projects API.
async function createProject({ name, description, customerId }) {
  const c = await accessToken();
  const mutation = `mutation CreateProject($name: String!, $description: String, $customer: ProjectManagement_CustomerInput) {
    projectManagementCreateProject(input: { name: $name, description: $description, customer: $customer, status: OPEN }) {
      ... on ProjectManagement_Project { id name }
    }
  }`;
  const r = await fetch(gqlUrl(), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + c.access_token, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: mutation, variables: { name, description: description || '', customer: { id: String(customerId) } } }),
  });
  const body = await r.json().catch(() => ({}));
  const p = body && body.data && body.data.projectManagementCreateProject;
  if (!r.ok || !p || !p.id) {
    const msg = (body.errors && body.errors[0] && body.errors[0].message) || ('Projects API answered ' + r.status);
    throw new Error('Could not create the QuickBooks project: ' + msg);
  }
  return { id: String(p.id), name: p.name };
}

// Fallback when this Intuit app has not been granted the Projects API: a
// sub-customer under the GC. It holds the job's estimate and costs the same way,
// and the controller can convert it to a project from inside QuickBooks.
async function createSubCustomer({ name, customerId }) {
  const body = await qboPost('/customer', {
    DisplayName: String(name).slice(0, 100),
    Job: true,
    BillWithParent: true,
    ParentRef: { value: String(customerId) },
  });
  return { id: body.Customer.Id, name: body.Customer.DisplayName };
}

async function createEstimate({ customerId, projectId, projectKind, lines, itemId, memo, privateNote }) {
  const Line = lines.map(l => (l.amount > 0
    ? {
      Amount: l.amount,
      Description: l.description,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: String(itemId) }, Qty: 1, UnitPrice: l.amount },
    }
    : { Description: l.description, DetailType: 'DescriptionOnly', DescriptionOnlyLineDetail: {} }));
  const payload = {
    Line,
    TxnDate: new Date().toISOString().slice(0, 10),
    CustomerMemo: memo ? { value: String(memo).slice(0, 1000) } : undefined,
    PrivateNote: privateNote ? String(privateNote).slice(0, 4000) : undefined,
  };
  if (projectKind === 'project') {
    payload.CustomerRef = { value: String(customerId) };
    payload.ProjectRef = { value: String(projectId) };
  } else {
    // A sub-customer is itself the customer on the estimate.
    payload.CustomerRef = { value: String(projectId) };
  }
  try {
    const body = await qboPost('/estimate', payload);
    return { id: body.Estimate.Id, docNumber: body.Estimate.DocNumber || '', total: +body.Estimate.TotalAmt || 0 };
  } catch (err) {
    // A QuickBooks project is also a customer record with the same id. If this
    // company will not take ProjectRef, file the estimate against the project
    // as its customer, which is how QuickBooks itself shows it.
    if (projectKind !== 'project' || err.status !== 400) throw err;
    delete payload.ProjectRef;
    payload.CustomerRef = { value: String(projectId) };
    const body = await qboPost('/estimate', payload);
    return { id: body.Estimate.Id, docNumber: body.Estimate.DocNumber || '', total: +body.Estimate.TotalAmt || 0 };
  }
}

// Link straight to the record inside QuickBooks for the controller.
function estimateUrl(id) {
  const host = isProd() ? 'https://qbo.intuit.com' : 'https://sandbox.qbo.intuit.com';
  return host + '/app/estimate?txnId=' + encodeURIComponent(id);
}

module.exports = {
  isConfigured, isProd, authorizeUrl, exchangeCode, getConnection, accessToken, disconnect,
  searchCustomers, findCustomerByName, createCustomer, listServiceItems,
  createProject, createSubCustomer, createEstimate, estimateUrl, PROJECT_SCOPE,
};

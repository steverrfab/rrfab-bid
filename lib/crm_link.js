'use strict';
// Talking to the CRM (rrfab-os).
//
// Deliberately isolated from the database and the estimates route, the same way
// lib/tracker_push.js is, so a CRM problem can never affect the bid tool. Every call
// has a short timeout and returns a plain message instead of throwing something ugly
// into a route. Nothing here is required for a bid to be created, edited, priced,
// printed or won.
//
// Configuration (Railway env vars on the bid service):
//   CRM_API_URL  base URL of the CRM API, e.g. https://api.rrfabrication.org
//   CRM_KEY      shared secret, matching CRM_INTEGRATION_KEY on the CRM
// If either is missing, callers get NOT_CONFIGURED and the Client box carries on as a
// plain text field.
const TIMEOUT_MS = 6000;

function crmConfig() {
  const base = (process.env.CRM_API_URL || '').replace(/\/+$/, '');
  const key = process.env.CRM_KEY || '';
  return base && key ? { base, key } : null;
}

function notConfigured() {
  const e = new Error('CRM connection not configured');
  e.code = 'NOT_CONFIGURED';
  return e;
}

async function crmFetch(path, options = {}) {
  const cfg = crmConfig();
  if (!cfg) throw notConfigured();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(cfg.base + path, {
      ...options,
      headers: { 'Content-Type': 'application/json', 'X-Integration-Key': cfg.key, ...(options.headers || {}) },
      signal: ctrl.signal,
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(body.error || ('The CRM answered with status ' + r.status));
      e.status = r.status;
      throw e;
    }
    return body;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('The CRM took too long to answer');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Companies whose name looks like what was typed. [] on an empty query.
async function searchCompanies(q, limit) {
  const query = String(q || '').trim();
  if (!query) return [];
  const body = await crmFetch(`/api/integration/companies/search?q=${encodeURIComponent(query)}&limit=${Number(limit) || 10}`);
  return Array.isArray(body.rows) ? body.rows : [];
}

// Create a company in the CRM with a name and nothing else. The CRM defaults the rest
// and flags the row so someone can finish it there later.
async function createCompany(name) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim();
  // A bad name is the caller's mistake, not the CRM being unreachable. Mark it so the
  // route answers 400 rather than reporting the CRM as broken.
  if (!clean) { const e = new Error('A company name is required'); e.status = 400; throw e; }
  return crmFetch('/api/integration/companies', { method: 'POST', body: JSON.stringify({ name: clean }) });
}

async function ping() {
  return crmFetch('/api/integration/ping');
}

function isConfigured() { return !!crmConfig(); }

module.exports = { searchCompanies, createCompany, ping, isConfigured };

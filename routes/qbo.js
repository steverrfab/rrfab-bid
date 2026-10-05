'use strict';
// QuickBooks Online: Won bid -> controller approval -> QB project + estimate.
//
//   1. The estimator (Joe) clicks "Send to QuickBooks" on a Won bid. That only
//      adds a row to qbo_push_requests. Nothing is written to QuickBooks.
//   2. A controller opens the QuickBooks page, checks the GC match and the lines,
//      and approves or sends it back.
//   3. Approve creates, in order: the GC customer (if new), the project under it,
//      and the estimate on that project. Each id is saved as soon as it exists,
//      so a failure part-way can be retried without duplicates in QuickBooks.
//
// The bid itself is never changed by any of this.
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
const qbo = require('../lib/qbo');
const { effectiveQbRole } = require('../lib/access');

const STATE_PURPOSE = 'qbo-connect';

// ---- helpers ----

function isController(req) {
  if (!req.user || !req.user.userId) return false;
  const u = db.prepare('SELECT role, qb_role FROM users WHERE id = ?').get(req.user.userId);
  return effectiveQbRole(u) === 'controller';
}

function requireController(req, res, next) {
  if (req.method === 'OPTIONS') return next();
  if (!isController(req)) return res.status(403).json({ error: 'Only a QuickBooks controller can do this. Ask an admin to turn it on for you on the Users screen.' });
  next();
}

// Which bids may go to QuickBooks: the same real, confirmed, Won bids that count
// on the dashboard and go to the Project Tracker.
function eligibility(e) {
  if (!e || e.deleted_at) return 'This bid was not found.';
  if (e.status !== 'Won') return 'Only a Won bid can be sent to QuickBooks.';
  if (e.bid_type && e.bid_type !== 'real') return 'Demo and test bids are not sent to QuickBooks.';
  if (e.is_alternate) return 'Alternates are not sent to QuickBooks on their own.';
  if (e.change_order_id) return 'Change orders are not sent from here.';
  if (!e.confirmed) return 'Confirm the bid before sending it to QuickBooks.';
  return null;
}

// The estimate lines: the bid's schedule of values, exactly what the Project
// Tracker gets, in whole dollars that foot to the contract. Alternate lines are
// left out because they are not part of the awarded contract.
function linesFor(estimateId) {
  let items = db.prepare(
    'SELECT item_no, description, scheduled_value FROM sov_items WHERE estimate_id = ? ORDER BY position, id'
  ).all(estimateId);
  if (items.length === 0) {
    const { loadFullEstimate } = require('./estimates');
    const bundle = loadFullEstimate(estimateId);
    if (bundle) items = require('./sov').autoGenerateItems(bundle);
  }
  return items
    .filter(it => !String(it.item_no || '').toUpperCase().startsWith('ALT'))
    .map((it, i) => {
      const no = it.item_no != null && it.item_no !== '' ? String(it.item_no) : String(i + 1);
      const amount = Math.round((+it.scheduled_value || 0) * 100) / 100;
      return { item_no: no, description: (no === '0' ? '' : no + '. ') + (it.description || ''), amount };
    });
}

const linesTotal = (lines) => Math.round(lines.reduce((a, l) => a + (l.amount > 0 ? l.amount : 0), 0) * 100) / 100;

function projectName(e) {
  const num = (e.job_number || e.bid_number || '').toString().trim();
  return [num, (e.project_name || '').trim()].filter(Boolean).join(' ') || ('Bid ' + e.id);
}

function requestRow(id) {
  return db.prepare(`
    SELECT r.*, e.project_name, e.job_number, e.bid_number, e.client_gc, e.status AS estimate_status,
           ru.name AS requested_by_name, vu.name AS reviewed_by_name
      FROM qbo_push_requests r
      JOIN estimates e ON e.id = r.estimate_id
      LEFT JOIN users ru ON ru.id = r.requested_by
      LEFT JOIN users vu ON vu.id = r.reviewed_by
     WHERE r.id = ?`).get(id);
}

function withLink(r) {
  if (!r) return r;
  return { ...r, qb_estimate_url: r.qb_estimate_id ? qbo.estimateUrl(r.qb_estimate_id) : null };
}

function connectionSummary() {
  const c = qbo.getConnection();
  return {
    configured: qbo.isConfigured(),
    environment: qbo.isProd() ? 'production' : 'sandbox',
    connected: !!c,
    company_name: c ? c.company_name : null,
    has_project_scope: c ? !!c.has_project_scope : false,
    item_id: c ? c.item_id : null,
    item_name: c ? c.item_name : null,
    connected_at: c ? c.connected_at : null,
  };
}

// ---- per-bid routes: /api/estimates/:id/qbo (estimator owns the bid) ----

const estimateRouter = express.Router({ mergeParams: true });

estimateRouter.get('/', (req, res) => {
  const id = Number(req.params.id);
  const e = db.prepare('SELECT * FROM estimates WHERE id = ?').get(id);
  if (!e) return res.status(404).json({ error: 'not found' });
  const latest = db.prepare('SELECT id FROM qbo_push_requests WHERE estimate_id = ? ORDER BY id DESC LIMIT 1').get(id);
  res.json({
    eligible: !eligibility(e),
    reason: eligibility(e),
    request: latest ? withLink(requestRow(latest.id)) : null,
  });
});

estimateRouter.post('/', (req, res) => {
  const id = Number(req.params.id);
  const e = db.prepare('SELECT * FROM estimates WHERE id = ?').get(id);
  const why = eligibility(e);
  if (why) return res.status(400).json({ error: why });
  const open = db.prepare("SELECT status FROM qbo_push_requests WHERE estimate_id = ? AND status IN ('pending','failed','sent') ORDER BY id DESC LIMIT 1").get(id);
  if (open && open.status === 'sent') return res.status(409).json({ error: 'This bid is already in QuickBooks.' });
  if (open) return res.status(409).json({ error: 'This bid is already waiting for the controller.' });
  const note = String((req.body && req.body.note) || '').trim().slice(0, 1000) || null;
  const info = db.prepare('INSERT INTO qbo_push_requests (estimate_id, status, requested_by, request_note) VALUES (?, \'pending\', ?, ?)')
    .run(id, req.user.userId, note);
  console.log(`[qbo] bid ${id} sent for QuickBooks approval by user ${req.user.userId}`);
  res.json({ ok: true, request: withLink(requestRow(info.lastInsertRowid)) });
});

// Take back a request that is still waiting.
estimateRouter.delete('/', (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare("SELECT id FROM qbo_push_requests WHERE estimate_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1").get(id);
  if (!r) return res.status(404).json({ error: 'Nothing is waiting for approval on this bid.' });
  db.prepare('DELETE FROM qbo_push_requests WHERE id = ?').run(r.id);
  res.json({ ok: true });
});

// ---- controller routes: /api/qbo ----

const router = express.Router();

// Who may open the QuickBooks page at all (the frontend asks before showing it).
router.get('/status', (req, res) => {
  const pending = db.prepare("SELECT COUNT(*) AS n FROM qbo_push_requests WHERE status IN ('pending','failed')").get().n;
  res.json({ ...connectionSummary(), is_controller: isController(req), waiting: pending });
});

router.use(requireController);

// Start connecting: hands back Intuit's sign-in page.
router.get('/connect', (req, res) => {
  if (!qbo.isConfigured()) {
    return res.status(503).json({ error: 'QuickBooks keys are not set on the server yet (QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REDIRECT_URI).' });
  }
  const state = jwt.sign({ purpose: STATE_PURPOSE, userId: req.user.userId }, process.env.JWT_SECRET, { expiresIn: '15m' });
  res.json({ url: qbo.authorizeUrl(state) });
});

router.post('/disconnect', async (req, res) => {
  await qbo.disconnect();
  console.log(`[qbo] disconnected by user ${req.user.userId}`);
  res.json({ ok: true });
});

router.get('/items', async (req, res) => {
  res.json({ items: await qbo.listServiceItems() });
});

router.put('/item', (req, res) => {
  const { item_id, item_name } = req.body || {};
  if (!item_id) return res.status(400).json({ error: 'Pick a product/service.' });
  const r = db.prepare('UPDATE qbo_connection SET item_id = ?, item_name = ? WHERE id = 1').run(String(item_id), String(item_name || ''));
  if (!r.changes) return res.status(400).json({ error: 'Connect QuickBooks first.' });
  res.json({ ok: true });
});

router.get('/customers', async (req, res) => {
  res.json({ customers: await qbo.searchCustomers(req.query.q) });
});

router.get('/requests', (req, res) => {
  const status = String(req.query.status || 'open');
  const where = status === 'open' ? "r.status IN ('pending','failed')" : status === 'done' ? "r.status IN ('sent','rejected')" : '1=1';
  const ids = db.prepare(`SELECT r.id FROM qbo_push_requests r WHERE ${where} ORDER BY r.requested_at DESC, r.id DESC LIMIT 200`).all();
  res.json({ requests: ids.map(x => withLink(requestRow(x.id))) });
});

// What approving would create: the GC match, the project name and the lines.
router.get('/requests/:rid/preview', async (req, res) => {
  const r = requestRow(Number(req.params.rid));
  if (!r) return res.status(404).json({ error: 'not found' });
  const lines = linesFor(r.estimate_id);
  let match = null;
  if (r.qb_customer_id) match = { id: r.qb_customer_id, name: r.qb_customer_name };
  else if (qbo.getConnection() && r.client_gc) {
    try { match = await qbo.findCustomerByName(r.client_gc.trim()); } catch (err) { console.error('[qbo] customer match failed:', err.message); }
  }
  res.json({
    request: withLink(r),
    project_name: projectName(r),
    customer_match: match,
    lines,
    total: linesTotal(lines),
    connection: connectionSummary(),
  });
});

const inFlight = new Set();

// Approve: create the customer (if needed), the project and the estimate.
// body: { customer_id?, customer_name? }  Leave both out to use the exact name
// match, or to create the GC in QuickBooks when there is none.
router.post('/requests/:rid/approve', async (req, res) => {
  const rid = Number(req.params.rid);
  const r = requestRow(rid);
  if (!r) return res.status(404).json({ error: 'not found' });
  if (!['pending', 'failed'].includes(r.status)) return res.status(409).json({ error: 'This one has already been handled.' });
  const conn = qbo.getConnection();
  if (!conn) return res.status(400).json({ error: 'Connect QuickBooks first.' });
  if (!conn.item_id) return res.status(400).json({ error: 'Pick the QuickBooks product/service for estimate lines first.' });
  if (inFlight.has(rid)) return res.status(409).json({ error: 'Already sending. Give it a moment.' });

  const e = db.prepare('SELECT * FROM estimates WHERE id = ?').get(r.estimate_id);
  const why = eligibility(e);
  if (why) return res.status(400).json({ error: why });
  const lines = linesFor(r.estimate_id);
  if (!lines.some(l => l.amount > 0)) return res.status(400).json({ error: 'This bid has no schedule of values to send.' });

  const save = (sets) => {
    const keys = Object.keys(sets);
    db.prepare(`UPDATE qbo_push_requests SET ${keys.map(k => k + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`)
      .run(...keys.map(k => sets[k]), rid);
  };
  const reviewNote = String((req.body && req.body.note) || '').trim().slice(0, 1000) || null;

  inFlight.add(rid);
  try {
    // 1. The GC.
    let customer = r.qb_customer_id ? { id: r.qb_customer_id, name: r.qb_customer_name } : null;
    if (!customer && req.body && req.body.customer_id) {
      customer = { id: String(req.body.customer_id), name: String(req.body.customer_name || '') };
    }
    if (!customer) {
      const gc = (e.client_gc || '').trim();
      if (!gc) throw new Error('This bid has no GC name. Pick the QuickBooks customer instead.');
      customer = await qbo.findCustomerByName(gc) || await qbo.createCustomer(gc);
    }
    save({ qb_customer_id: customer.id, qb_customer_name: customer.name });

    // 2. The project under the GC (or a sub-customer when the Projects API is not granted).
    let projectId = r.qb_project_id, kind = r.qb_project_kind;
    if (!projectId) {
      const name = projectName(e);
      const desc = [e.scope || '', e.bid_number ? 'Bid #' + e.bid_number : ''].filter(Boolean).join(' | ').slice(0, 1000);
      const p = conn.has_project_scope
        ? await qbo.createProject({ name, description: desc, customerId: customer.id })
        : await qbo.createSubCustomer({ name, customerId: customer.id });
      projectId = p.id;
      kind = conn.has_project_scope ? 'project' : 'sub_customer';
      save({ qb_project_id: projectId, qb_project_kind: kind });
    }

    // 3. The estimate on the project.
    const est = await qbo.createEstimate({
      customerId: customer.id, projectId, projectKind: kind, lines, itemId: conn.item_id,
      memo: e.project_name || '',
      privateNote: `From R&R Bid Tool. Bid #${e.bid_number || ''} Job #${e.job_number || ''} (estimate ${e.id})`,
    });
    save({
      status: 'sent', qb_estimate_id: est.id, qb_total: est.total || linesTotal(lines), error: null,
      reviewed_by: req.user.userId, reviewed_at: new Date().toISOString(), review_note: reviewNote,
    });
    console.log(`[qbo] bid ${e.id} sent to QuickBooks: customer ${customer.id}, ${kind} ${projectId}, estimate ${est.id}`);
    res.json({ ok: true, request: withLink(requestRow(rid)) });
  } catch (err) {
    console.error(`[qbo] sending bid ${r.estimate_id} failed:`, err.message);
    save({ status: 'failed', error: err.message, reviewed_by: req.user.userId, reviewed_at: new Date().toISOString() });
    res.status(502).json({ error: err.message, request: withLink(requestRow(rid)) });
  } finally {
    inFlight.delete(rid);
  }
});

// Send it back without touching QuickBooks. Joe can send it again after fixing it.
router.post('/requests/:rid/reject', (req, res) => {
  const rid = Number(req.params.rid);
  const r = db.prepare('SELECT status FROM qbo_push_requests WHERE id = ?').get(rid);
  if (!r) return res.status(404).json({ error: 'not found' });
  if (!['pending', 'failed'].includes(r.status)) return res.status(409).json({ error: 'This one has already been handled.' });
  const note = String((req.body && req.body.note) || '').trim().slice(0, 1000) || null;
  db.prepare("UPDATE qbo_push_requests SET status = 'rejected', review_note = ?, reviewed_by = ?, reviewed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
    .run(note, req.user.userId, rid);
  res.json({ ok: true, request: withLink(requestRow(rid)) });
});

// ---- OAuth return from Intuit (public: guarded by the signed state) ----

async function callback(req, res) {
  const back = (process.env.QBO_APP_RETURN_URL || ((process.env.FRONTEND_URL || 'https://bid.rrfabrication.org') + '/#/quickbooks'));
  const go = (result) => res.redirect(back + (back.includes('?') ? '&' : '?') + 'qbo=' + encodeURIComponent(result));
  const { code, state, realmId, error } = req.query;
  if (error) return go('denied');
  let payload;
  try {
    payload = jwt.verify(String(state || ''), process.env.JWT_SECRET);
  } catch {
    return go('expired');
  }
  if (!payload || payload.purpose !== STATE_PURPOSE || !code || !realmId) return go('error');
  try {
    await qbo.exchangeCode(String(code), String(realmId), payload.userId);
    console.log(`[qbo] connected to company ${realmId} by user ${payload.userId}`);
    go('connected');
  } catch (err) {
    console.error('[qbo] connect failed:', err.message);
    go('error');
  }
}

// The path Intuit sends people back to, taken from QBO_REDIRECT_URI so the two
// can never disagree. Falls back to /api/qbo/callback.
function callbackPath() {
  try {
    const p = new URL(process.env.QBO_REDIRECT_URI).pathname.replace(/\/+$/, '');
    if (p) return p;
  } catch { /* not set or not a URL */ }
  return '/api/qbo/callback';
}

module.exports = { router, estimateRouter, callback, callbackPath, linesFor, eligibility, projectName };

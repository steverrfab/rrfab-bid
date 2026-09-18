'use strict';
// The bid tool's own front door to the CRM. The browser calls these; they call the
// CRM with the shared key, so the secret never leaves the server.
//
// A CRM that is down or not configured returns 503 with a plain message. The Client /
// GC box treats that as "carry on as a text field", which is the whole point: a bid is
// never blocked on the CRM being reachable.
const express = require('express');
const crm = require('../lib/crm_link');

const router = express.Router();

function fail(res, e) {
  if (e.code === 'NOT_CONFIGURED') return res.status(503).json({ error: e.message, notConfigured: true });
  return res.status(502).json({ error: e.message });
}

// GET /api/crm/companies?q=harkins
router.get('/companies', async (req, res) => {
  try {
    res.json({ rows: await crm.searchCompanies(req.query.q, req.query.limit) });
  } catch (e) { fail(res, e); }
});

// POST /api/crm/companies { name }
router.post('/companies', async (req, res) => {
  try {
    res.json(await crm.createCompany(req.body?.name));
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    fail(res, e);
  }
});

// GET /api/crm/status — is the link wired up? Used by Settings.
router.get('/status', async (req, res) => {
  if (!crm.isConfigured()) return res.json({ configured: false, reachable: false });
  try {
    await crm.ping();
    res.json({ configured: true, reachable: true });
  } catch (e) {
    res.json({ configured: true, reachable: false, error: e.message });
  }
});

module.exports = router;

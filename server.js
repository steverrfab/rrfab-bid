'use strict';
const express = require('express');
const cors = require('cors');

// Initialize database (runs migrations + seed on import)
const db = require('./db');
const { requireAuth, requireAdmin } = require('./lib/auth');
const { isConfigured: smtpConfigured } = require('./lib/email');
const { estimateOwnershipCheck } = require('./routes/estimates');

const app = express();
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN ? process.env.FRONTEND_ORIGIN.split(',') : true,
  credentials: false
}));
app.use(express.json({ limit: '10mb' }));

app.use(requireAuth);

// ---- Health ----
app.get('/api/health', (req, res) => {
  const aiscCount = db.prepare('SELECT COUNT(*) as n FROM aisc_sections').get().n;
  const estCount = db.prepare('SELECT COUNT(*) as n FROM estimates').get().n;
  const recipCount = db.prepare('SELECT COUNT(*) as n FROM notification_recipients').get().n;
  res.json({
    ok: true,
    service: 'rrfab-bid',
    aisc_sections: aiscCount,
    estimates: estCount,
    notification_recipients: recipCount,
    smtp_configured: smtpConfigured(),
    time: new Date().toISOString()
  });
});

// ---- Routes ----
app.use('/api/auth', require('./routes/auth'));
app.use('/api/aisc', require('./routes/aisc'));
app.use('/api/estimates', require('./routes/estimates').router);
// Estimate subrouters — estimators can only access their own estimates
app.use('/api/estimates/:id/wages',          estimateOwnershipCheck, require('./routes/wages'));
app.use('/api/estimates/:id/proposal-pdf',   estimateOwnershipCheck, require('./routes/proposal'));
app.use('/api/estimates/:id/extras',         estimateOwnershipCheck, require('./routes/extras'));
app.use('/api/estimates/:id/site-exclusions',estimateOwnershipCheck, require('./routes/exclusions').siteRouter);
app.use('/api/estimates/:id/sov',            estimateOwnershipCheck, require('./routes/sov'));
app.use('/api/estimates/:id/proposal-lines', estimateOwnershipCheck, require('./routes/proposal_lines'));
app.use('/api/template', require('./routes/template'));
app.use('/api/feedback', require('./routes/feedback'));
// Company settings — admin and superadmin only
app.use('/api/recipients',          requireAdmin, require('./routes/recipients'));
app.use('/api/settings/prices',     requireAdmin, require('./routes/prices'));
app.use('/api/settings/proposal-defaults', requireAdmin, require('./routes/proposal_defaults'));
app.use('/api/contacts',            requireAdmin, require('./routes/contacts'));
app.use('/api/standard-exclusions', requireAdmin, require('./routes/exclusions').stdRouter);
app.use('/api/users', require('./routes/users'));
app.use('/api/change-orders', require('./routes/change_orders'));

// ---- Root ----
app.get('/', (req, res) => {
  res.json({
    service: 'rrfab-bid',
    status: 'ok',
    docs: 'See README.md',
  });
});

// 404
app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));

// Error handler
app.use((err, req, res, next) => {
  console.error('server error:', err);
  res.status(500).json({ error: err.message || 'internal error' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('rrfab-bid listening on', PORT));

'use strict';
const express = require('express');
const cors = require('cors');

// Initialize database (runs migrations + seed on import)
const db = require('./db');
const { requireAuth } = require('./lib/auth');
const { isConfigured: smtpConfigured } = require('./lib/email');

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
app.use('/api/estimates', require('./routes/estimates'));
app.use('/api/estimates/:id/wages', require('./routes/wages'));
app.use('/api/estimates/:id/proposal-pdf', require('./routes/proposal'));
app.use('/api/template', require('./routes/template'));
app.use('/api/recipients', require('./routes/recipients'));
app.use('/api/settings/prices', require('./routes/prices'));

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[rrfab-bid] listening on :${PORT}`);
  console.log(`[rrfab-bid] SMTP configured: ${smtpConfigured()}`);
});

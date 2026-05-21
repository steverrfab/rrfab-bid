'use strict';
// Email sender for "Ready to Submit" notifications.
// Configured via env vars on Railway:
//   SMTP_HOST   (default: smtp.office365.com)
//   SMTP_PORT   (default: 587)
//   SMTP_USER   (required for sending)
//   SMTP_PASS   (required for sending)
//   SMTP_FROM   (default: SMTP_USER)
//   SMTP_SECURE (default: false; set to "true" for port 465)
//
// If SMTP_USER or SMTP_PASS are missing, send becomes a logged no-op.
// The submit flow still succeeds. Status still flips. Email is best-effort.

let nodemailer = null;
try { nodemailer = require('nodemailer'); }
catch (e) { console.warn('[email] nodemailer not installed; emails disabled'); }

const FROM_NAME = 'R&R Bid';

function isConfigured() {
  return !!(nodemailer && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function buildTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.office365.com',
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

function fromAddress() {
  const addr = process.env.SMTP_FROM || process.env.SMTP_USER;
  return `"${FROM_NAME}" <${addr}>`;
}

function money(n) {
  const v = Math.round(+n || 0);
  return '$' + v.toLocaleString('en-US');
}

function buildBody(estimate, computed) {
  const e = estimate, c = computed || {};
  const subject = `Ready to Submit: ${e.project_name || 'Untitled'} - Bid #${e.bid_number || e.id}`;
  const rows = [
    ['Project', e.project_name || ''],
    ['Client / GC', e.client_gc || ''],
    ['Bid #', e.bid_number || ''],
    ['Job #', e.job_number || ''],
    ['Bid Date', e.bid_date || ''],
    ['Prepared By', e.prepared_by || ''],
    ['Total Weight', `${Math.round(c.materialWeight || 0).toLocaleString()} lb`],
    ['Sell Price', money(c.sellPrice)],
    ['Margin', c.marginPct != null ? `${(c.marginPct * 100).toFixed(1)}%` : '']
  ];
  const tableRows = rows
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">${k}</td><td style="padding:4px 0;font-size:13px;"><b>${v || '-'}</b></td></tr>`)
    .join('');
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#222;max-width:600px;">
      <p style="margin:0 0 14px 0;">This estimate has been flagged as <b>ready to submit</b> in R&amp;R Bid.</p>
      <p style="margin:0 0 14px 0;">PDF proposal is attached. Upload it to the destination folder, then submit to the GC per the usual process.</p>
      <table style="border-collapse:collapse;margin:14px 0 18px 0;">${tableRows}</table>
      <p style="font-size:12px;color:#888;margin:18px 0 0 0;">Scope summary: ${(e.scope || '').replace(/\n/g, '<br>') || '(none)'}</p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0 12px 0;">
      <p style="font-size:11px;color:#999;margin:0;">Sent by R&amp;R Bid. Reply directly to coordinate.</p>
    </div>
  `;
  const text = rows.map(([k, v]) => `${k}: ${v || '-'}`).join('\n') +
    `\n\nScope: ${e.scope || '(none)'}\n\nPDF attached.`;
  return { subject, html, text };
}

// Send the ready-to-submit notification.
//   bundle: { estimate, computed }
//   recipients: array of { email, name }
//   pdfBuffer: Buffer with the proposal PDF
// Returns { ok, sent, skipped, error? }
async function sendReadyToSubmit(bundle, recipients, pdfBuffer) {
  if (!recipients || recipients.length === 0) {
    return { ok: true, sent: 0, skipped: 'no recipients configured' };
  }
  if (!isConfigured()) {
    console.warn('[email] SMTP not configured; would have notified:', recipients.map(r => r.email).join(', '));
    return { ok: true, sent: 0, skipped: 'SMTP not configured (set SMTP_USER and SMTP_PASS)' };
  }
  try {
    const transport = buildTransport();
    const { subject, html, text } = buildBody(bundle.estimate, bundle.computed);
    const filename = `Proposal_${bundle.estimate.bid_number || bundle.estimate.id}.pdf`;
    const info = await transport.sendMail({
      from: fromAddress(),
      to: recipients.map(r => r.name ? `"${r.name}" <${r.email}>` : r.email).join(', '),
      subject,
      text,
      html,
      attachments: pdfBuffer ? [{ filename, content: pdfBuffer, contentType: 'application/pdf' }] : []
    });
    console.log('[email] sent:', info.messageId, 'to', recipients.length, 'recipients');
    return { ok: true, sent: recipients.length };
  } catch (err) {
    console.error('[email] send failed:', err);
    return { ok: false, sent: 0, error: err.message };
  }
}

module.exports = { sendReadyToSubmit, isConfigured };

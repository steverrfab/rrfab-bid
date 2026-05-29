'use strict';
// Email sender for "Ready to Submit" notifications.
//
// Primary path: Microsoft Graph API (HTTPS, works on Railway).
//   AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_SENDER_USER, AZURE_SENDER_DISPLAY
//
// Fallback path: SMTP via nodemailer.
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_SECURE
//
// If neither is configured the send becomes a logged no-op; submit still succeeds.

let nodemailer = null;
try { nodemailer = require('nodemailer'); }
catch (e) { /* nodemailer optional */ }

const FROM_NAME = 'R&R Bid';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const TOKEN_TIMEOUT_MS = 10000;
const SEND_TIMEOUT_MS = 20000;

function graphConfigured() {
  return !!(
    process.env.AZURE_TENANT_ID &&
    process.env.AZURE_CLIENT_ID &&
    process.env.AZURE_CLIENT_SECRET &&
    process.env.AZURE_SENDER_USER
  );
}
function smtpConfigured() {
  return !!(nodemailer && process.env.SMTP_USER && process.env.SMTP_PASS);
}
function isConfigured() {
  return graphConfigured() || smtpConfigured();
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

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}

// ---------- Microsoft Graph ----------
let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getGraphToken() {
  const now = Date.now();
  if (cachedToken && cachedTokenExpiresAt > now + 60000) return cachedToken;
  const tenant = process.env.AZURE_TENANT_ID;
  const url = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: process.env.AZURE_CLIENT_ID,
    client_secret: process.env.AZURE_CLIENT_SECRET,
    scope: GRAPH_SCOPE,
    grant_type: 'client_credentials'
  }).toString();
  const res = await withTimeout(
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }),
    TOKEN_TIMEOUT_MS, 'OAuth token request'
  );
  if (!res.ok) { const t = await res.text(); throw new Error(`Token request failed: ${res.status} ${t}`); }
  const data = await res.json();
  cachedToken = data.access_token;
  cachedTokenExpiresAt = now + (data.expires_in * 1000);
  return cachedToken;
}

async function sendViaGraph(bundle, recipients, pdfBuffer) {
  const sender = process.env.AZURE_SENDER_USER;
  const displayName = process.env.AZURE_SENDER_DISPLAY || FROM_NAME;
  const { subject, html } = buildBody(bundle.estimate, bundle.computed);
  const message = {
    subject,
    body: { contentType: 'HTML', content: html },
    from: { emailAddress: { address: sender, name: displayName } },
    toRecipients: recipients.map(r => ({ emailAddress: { address: r.email, name: r.name || undefined } })),
    attachments: pdfBuffer ? [{
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: `Proposal_${bundle.estimate.bid_number || bundle.estimate.id}.pdf`,
      contentType: 'application/pdf',
      contentBytes: pdfBuffer.toString('base64')
    }] : []
  };
  const token = await getGraphToken();
  const res = await withTimeout(
    fetch(`${GRAPH_BASE}/users/${encodeURIComponent(sender)}/sendMail`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, saveToSentItems: 'true' })
    }),
    SEND_TIMEOUT_MS, 'Graph sendMail'
  );
  if (res.status === 202) return { ok: true, sent: recipients.length };
  const text = await res.text();
  throw new Error(`Graph sendMail failed: ${res.status} ${text}`);
}

// ---------- SMTP fallback ----------
function buildSmtpTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.office365.com',
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 12000
  });
}
function smtpFromAddress() {
  const explicit = process.env.SMTP_FROM;
  if (explicit) return explicit;
  return `"${FROM_NAME}" <${process.env.SMTP_USER}>`;
}
async function sendViaSmtp(bundle, recipients, pdfBuffer) {
  const transport = buildSmtpTransport();
  const { subject, html, text } = buildBody(bundle.estimate, bundle.computed);
  const filename = `Proposal_${bundle.estimate.bid_number || bundle.estimate.id}.pdf`;
  const info = await withTimeout(
    transport.sendMail({
      from: smtpFromAddress(),
      to: recipients.map(r => r.name ? `"${r.name}" <${r.email}>` : r.email).join(', '),
      subject, text, html,
      attachments: pdfBuffer ? [{ filename, content: pdfBuffer, contentType: 'application/pdf' }] : []
    }),
    SEND_TIMEOUT_MS, 'SMTP send'
  );
  return { ok: true, sent: recipients.length, messageId: info.messageId };
}

// ---------- Ready to Submit ----------
async function sendReadyToSubmit(bundle, recipients, pdfBuffer) {
  if (!recipients || recipients.length === 0) {
    return { ok: true, sent: 0, skipped: 'no recipients configured' };
  }
  if (!isConfigured()) {
    console.warn('[email] not configured; would have notified:', recipients.map(r => r.email).join(', '));
    return { ok: true, sent: 0, skipped: 'email not configured' };
  }
  const mode = graphConfigured() ? 'graph' : 'smtp';
  try {
    const result = mode === 'graph'
      ? await sendViaGraph(bundle, recipients, pdfBuffer)
      : await sendViaSmtp(bundle, recipients, pdfBuffer);
    console.log(`[email] sent via ${mode}: ${result.sent} recipient(s)`);
    return result;
  } catch (err) {
    console.error(`[email] send failed (${mode}):`, err.message || err);
    return { ok: false, sent: 0, error: err.message || String(err) };
  }
}

// ---------- Feedback ----------
// file: { buffer, name, type } or null
async function sendFeedback(message, context, file) {
  const FEEDBACK_TO = 'stevem@rrfabrication.org';
  const subject = 'R&R Bid — User Feedback';
  const contextLine = context ? `<p style="font-size:12px;color:#888;margin:0 0 14px 0;">Context: ${context}</p>` : '';
  const safeMsg = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#222;max-width:600px;">
      ${contextLine}
      <div style="background:#f5f5f5;border-radius:6px;padding:14px 16px;font-size:14px;white-space:pre-wrap;">${safeMsg}</div>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0 12px 0;">
      <p style="font-size:11px;color:#999;margin:0;">Sent from R&amp;R Bid feedback form.</p>
    </div>
  `;
  const text = (context ? `Context: ${context}\n\n` : '') + message;

  if (!isConfigured()) {
    console.warn('[email] feedback not sent (email not configured):', message.slice(0, 80));
    return { ok: false, skipped: 'email not configured' };
  }

  try {
    if (graphConfigured()) {
      const sender = process.env.AZURE_SENDER_USER;
      const displayName = process.env.AZURE_SENDER_DISPLAY || FROM_NAME;
      const token = await getGraphToken();
      const attachments = file ? [{
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: file.name,
        contentType: file.type || 'application/octet-stream',
        contentBytes: file.buffer.toString('base64')
      }] : [];
      const msgBody = {
        subject,
        body: { contentType: 'HTML', content: html },
        from: { emailAddress: { address: sender, name: displayName } },
        toRecipients: [{ emailAddress: { address: FEEDBACK_TO } }],
        attachments
      };
      const res = await withTimeout(
        fetch(`${GRAPH_BASE}/users/${encodeURIComponent(sender)}/sendMail`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: msgBody, saveToSentItems: 'true' })
        }),
        SEND_TIMEOUT_MS, 'Graph sendMail (feedback)'
      );
      if (res.status !== 202) {
        const t = await res.text();
        throw new Error(`Graph sendMail failed: ${res.status} ${t}`);
      }
    } else {
      const transport = buildSmtpTransport();
      await withTimeout(
        transport.sendMail({
          from: smtpFromAddress(),
          to: FEEDBACK_TO,
          subject, text, html,
          attachments: file ? [{ filename: file.name, content: file.buffer, contentType: file.type }] : []
        }),
        SEND_TIMEOUT_MS, 'SMTP send (feedback)'
      );
    }
    return { ok: true };
  } catch (err) {
    console.error('[email] feedback send failed:', err.message || err);
    return { ok: false, error: err.message || String(err) };
  }
}

module.exports = { sendReadyToSubmit, sendFeedback, isConfigured, graphConfigured, smtpConfigured };

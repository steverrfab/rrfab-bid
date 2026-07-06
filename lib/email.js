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

const { buildProposalView } = require('./proposal_lines');

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

function frontendUrl() {
  return process.env.FRONTEND_URL || 'https://bid.rrfabrication.org';
}

// Pull the right display numbers for a bundle. Process-only jobs keep their
// real numbers in processComputed; `computed` is all zeros for them, which is
// why the email previously showed $0 / 0 lb for those bids.
function displayNumbers(bundle) {
  const e = bundle.estimate || {};
  const c = bundle.computed || {};
  const pc = bundle.processComputed || {};
  const isPO = e.job_type === 'process_only';
  const weight = isPO
    ? (bundle.processLines || []).reduce((s, r) => s + (+r.weight_lb || 0), 0)
    : (c.materialWeight || 0);
  // Margin and sell price come from the shared proposal builder so this email
  // shows the SAME real burdened-cost margin as the PDF, SOV, and on-screen
  // proposal (not the old bid-rate margin), and respects price-to-win.
  const view = buildProposalView(bundle);
  return {
    sellPrice: isPO ? (pc.quoted || 0) : (view.subtotal || 0),
    marginPct: view.marginPct != null ? view.marginPct : null,
    weight
  };
}

function buildBody(bundle) {
  const e = bundle.estimate || {};
  const n = displayNumbers(bundle);
  const subject = `Ready to Submit: ${e.project_name || 'Untitled'} - Bid #${e.bid_number || e.id}`;
  const viewUrl = `${frontendUrl()}/#/estimate/${e.id}`;
  const rows = [
    ['Project', e.project_name || ''],
    ['Client / GC', e.client_gc || ''],
    ['Bid #', e.bid_number || ''],
    ['Job #', e.job_number || ''],
    ['Bid Date', e.bid_date || ''],
    ['Prepared By', e.prepared_by || ''],
    ['Total Weight', `${Math.round(n.weight || 0).toLocaleString()} lb`],
    ['Sell Price', money(n.sellPrice)],
    ['Margin', n.marginPct != null ? `${(n.marginPct * 100).toFixed(1)}%` : '']
  ];
  const tableRows = rows
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">${k}</td><td style="padding:4px 0;font-size:13px;"><b>${v || '-'}</b></td></tr>`)
    .join('');
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#222;max-width:600px;">
      <p style="margin:0 0 14px 0;">This estimate has been flagged as <b>ready to submit</b> in R&amp;R Bid.</p>
      <p style="margin:0 0 14px 0;">PDF proposal is attached. Upload it to the destination folder, then submit to the GC per the usual process.</p>
      <table style="border-collapse:collapse;margin:14px 0 18px 0;">${tableRows}</table>
      <p style="margin:0 0 18px 0;">
        <a href="${viewUrl}" style="display:inline-block;background:#ff6b35;color:#fff;font-weight:600;font-size:14px;padding:10px 24px;border-radius:6px;text-decoration:none;">View Bid</a>
      </p>
      <p style="font-size:12px;color:#888;margin:18px 0 0 0;">Scope summary: ${(e.scope || '').replace(/\n/g, '<br>') || '(none)'}</p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0 12px 0;">
      <p style="font-size:11px;color:#999;margin:0;">Sent by R&amp;R Bid. Reply directly to coordinate.</p>
    </div>
  `;
  const text = rows.map(([k, v]) => `${k}: ${v || '-'}`).join('\n') +
    `\n\nView bid: ${viewUrl}\n\nScope: ${e.scope || '(none)'}\n\nPDF attached.`;
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
  const { subject, html } = buildBody(bundle);
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
  const { subject, html, text } = buildBody(bundle);
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


// ---------- Invite ----------
async function sendInvite(toEmail, toName, inviteUrl) {
  const subject = 'You\'ve been invited to R&R Bid';
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#222;max-width:600px;">
      <p style="margin:0 0 14px 0;">Hi${toName ? ' ' + toName : ''},</p>
      <p style="margin:0 0 14px 0;">You've been invited to access <b>R&amp;R Bid</b>, the estimating tool for R&amp;R Fabrication.</p>
      <p style="margin:0 0 20px 0;">Click the button below to set your password and activate your account. This link expires in 48 hours.</p>
      <a href="${inviteUrl}" style="display:inline-block;background:#2563eb;color:#fff;font-weight:600;font-size:14px;padding:10px 24px;border-radius:6px;text-decoration:none;">Set Up My Account</a>
      <p style="margin:24px 0 0 0;font-size:12px;color:#888;">Or paste this link: ${inviteUrl}</p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0 12px 0;">
      <p style="font-size:11px;color:#999;margin:0;">Sent by R&amp;R Bid. If you weren't expecting this, you can ignore it.</p>
    </div>
  `;
  const text = `You've been invited to R&R Bid.\n\nSet up your account: ${inviteUrl}\n\nThis link expires in 48 hours.`;

  if (!isConfigured()) {
    console.log(`[email] invite not sent (email not configured). URL: ${inviteUrl}`);
    return { ok: false, skipped: 'email not configured' };
  }

  try {
    if (graphConfigured()) {
      const sender = process.env.AZURE_SENDER_USER;
      const displayName = process.env.AZURE_SENDER_DISPLAY || FROM_NAME;
      const token = await getGraphToken();
      const msgBody = {
        subject,
        body: { contentType: 'HTML', content: html },
        from: { emailAddress: { address: sender, name: displayName } },
        toRecipients: [{ emailAddress: { address: toEmail, name: toName || undefined } }]
      };
      const res = await withTimeout(
        fetch(`${GRAPH_BASE}/users/${encodeURIComponent(sender)}/sendMail`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: msgBody, saveToSentItems: 'true' })
        }),
        SEND_TIMEOUT_MS, 'Graph sendMail (invite)'
      );
      if (res.status !== 202) {
        const t = await res.text();
        throw new Error(`Graph sendMail failed: ${res.status} ${t}`);
      }
    } else {
      const transport = buildSmtpTransport();
      await withTimeout(
        transport.sendMail({ from: smtpFromAddress(), to: toEmail, subject, text, html }),
        SEND_TIMEOUT_MS, 'SMTP send (invite)'
      );
    }
    return { ok: true };
  } catch (err) {
    console.error('[email] invite send failed:', err.message || err);
    return { ok: false, error: err.message || String(err) };
  }
}

// ---- Won notification ----
async function sendWonNotification(bundle, recipients) {
  if (!isConfigured() || !recipients || !recipients.length) return { ok: true, skipped: true };
  const e = bundle.estimate;
  const num = displayNumbers(bundle);
  const viewUrl = `${frontendUrl()}/#/estimate/${e.id}`;
  const subject = `JOB WON: ${e.project_name || 'Untitled'} — Bid #${e.bid_number || e.id}`;
  function money2(n) { const v = Math.round(+n || 0); return '$' + v.toLocaleString('en-US'); }
  const html = `
<div style="font-family:Arial,sans-serif;max-width:600px">
  <div style="background:#1a1a1a;padding:16px 20px">
    <span style="color:#ff6b35;font-weight:700;font-size:16px">R&amp;R FABRICATION</span>
    <span style="color:#aaa;font-size:11px;margin-left:12px">Bid Tool</span>
  </div>
  <div style="padding:24px 20px;background:#fff">
    <p style="font-size:18px;font-weight:700;color:#16a34a;margin:0 0 16px">Job Won!</p>
    <table style="width:100%;font-size:13px;border-collapse:collapse">
      <tr><td style="color:#888;width:140px;padding:4px 0">Project</td><td style="font-weight:600">${e.project_name || '—'}</td></tr>
      <tr><td style="color:#888;padding:4px 0">Bid #</td><td>${e.bid_number || '—'}</td></tr>
      <tr><td style="color:#888;padding:4px 0">Client / GC</td><td>${e.client_gc || '—'}</td></tr>
      <tr><td style="color:#888;padding:4px 0">Total Bid</td><td style="font-weight:700;font-size:15px">${money2(num.sellPrice)}</td></tr>
      <tr><td style="color:#888;padding:4px 0">Material Weight</td><td>${Math.round(num.weight || 0).toLocaleString()} lb</td></tr>
    </table>
    <p style="margin:20px 0 0">
      <a href="${viewUrl}" style="display:inline-block;background:#ff6b35;color:#fff;font-weight:600;font-size:14px;padding:10px 24px;border-radius:6px;text-decoration:none">View Bid</a>
    </p>
    <p style="margin:20px 0 0;font-size:11px;color:#999">A Schedule of Values (SOV) has been auto-generated in the bid tool. Log in to review and download it.</p>
  </div>
  <div style="padding:10px 20px;background:#f5f5f5;font-size:10px;color:#999">R&amp;R Bid &middot; Automated notification</div>
</div>`;
  const text = `JOB WON: ${e.project_name || 'Untitled'} — Bid #${e.bid_number || e.id}\nClient: ${e.client_gc || '—'}\nTotal Bid: ${money2(num.sellPrice)}\nView bid: ${viewUrl}\nAn SOV has been generated — log in to review it.`;
  try {
    if (graphConfigured()) {
      const sender = process.env.AZURE_SENDER_USER;
      const displayName = process.env.AZURE_SENDER_DISPLAY || FROM_NAME;
      const token = await getGraphToken();
      await withTimeout(
        fetch(`${GRAPH_BASE}/users/${sender}/sendMail`, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: {
              subject,
              body: { contentType: 'HTML', content: html },
              from: { emailAddress: { address: sender, name: displayName } },
              toRecipients: recipients.map(r => ({ emailAddress: { address: r.email, name: r.name || r.email } }))
            },
            saveToSentItems: false
          })
        }),
        SEND_TIMEOUT_MS, 'Graph send (won)'
      );
    } else {
      const transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: Number(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      });
      await withTimeout(
        transport.sendMail({ from: smtpFromAddress(), to: recipients.map(r => r.email).join(','), subject, text, html }),
        SEND_TIMEOUT_MS, 'SMTP send (won)'
      );
    }
    return { ok: true };
  } catch (err) {
    console.error('[email] won notification failed:', err.message || err);
    return { ok: false, error: err.message || String(err) };
  }
}

async function sendAccessRequestNotification(request) {
  const NOTIFY = 'stevem@rrfabrication.org';
  const subject = `Access Request: ${request.name} (${request.email})`;
  const adminUrl = (process.env.FRONTEND_URL || 'https://bid.rrfabrication.org') + '/#/users';
  const html = `<div style="font-family:Arial,sans-serif;max-width:600px">
  <div style="background:#1a1a1a;padding:16px 20px">
    <span style="color:#ff6b35;font-weight:700;font-size:16px">R&R FABRICATION</span>
    <span style="color:#aaa;font-size:11px;margin-left:12px">Bid Tool</span>
  </div>
  <div style="padding:24px 20px;background:#fff">
    <p style="font-size:16px;font-weight:700;margin:0 0 16px">New Access Request</p>
    <table style="width:100%;font-size:13px;border-collapse:collapse">
      <tr><td style="color:#888;width:100px;padding:4px 0">Name</td><td style="font-weight:600">${request.name}</td></tr>
      <tr><td style="color:#888;padding:4px 0">Email</td><td>${request.email}</td></tr>
    </table>
    <p style="margin:20px 0 0">
      <a href="${adminUrl}" style="background:#ff6b35;color:#fff;padding:8px 16px;border-radius:4px;text-decoration:none;font-size:13px;font-weight:600">Review in Users Admin</a>
    </p>
  </div>
  <div style="padding:10px 20px;background:#f5f5f5;font-size:10px;color:#999">R&R Bid - Automated notification</div>
</div>`;
  const text = 'New access request from ' + request.name + ' (' + request.email + '). Review at: ' + adminUrl;
  try {
    if (graphConfigured()) {
      const sender = process.env.AZURE_SENDER_USER;
      const displayName = process.env.AZURE_SENDER_DISPLAY || FROM_NAME;
      const token = await getGraphToken();
      await withTimeout(
        fetch(GRAPH_BASE + '/users/' + sender + '/sendMail', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: {
              subject,
              body: { contentType: 'HTML', content: html },
              from: { emailAddress: { address: sender, name: displayName } },
              toRecipients: [{ emailAddress: { address: NOTIFY, name: 'Steve' } }]
            },
              saveToSentItems: false
          })
        }),
        SEND_TIMEOUT_MS, 'Graph send (access request)'
      );
    } else if (smtpConfigured()) {
      const transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: Number(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      });
      await withTimeout(
        transport.sendMail({ from: smtpFromAddress(), to: NOTIFY, subject, text, html }),
        SEND_TIMEOUT_MS, 'SMTP send (access request)'
      );
    } else {
      console.log('[email] access request (no email configured):', request.name, request.email);
    }
    return { ok: true };
  } catch (err) {
    console.error('[email] access request notification failed:', err.message || err);
    return { ok: false, error: err.message || String(err) };
  }
}

module.exports = { sendReadyToSubmit, sendFeedback, sendInvite, sendWonNotification, sendAccessRequestNotification, isConfigured, graphConfigured, smtpConfigured };

'use strict';
// Bid due-date reminders. Runs on a timer inside the API process.
//
// Every few minutes: find Bid Calendar bids with a due date AND time that are
// still being quoted (no estimate yet, or its estimate is still a Draft), and
// for each one inside its reminder window, email the estimator (and any admin
// who asked for copies). calendar_reminders records every send so a restart or
// a second replica can never send the same reminder twice. Nothing here
// touches the calendar or estimate rows themselves.
//
// Calendar bids with no due time get no reminder for now (to be decided).
//
// Kinds:
//   '24h'        due within the next 24 hours (fires once, as soon as the bid
//                enters that window, so a bid entered 3 hours before it is due
//                still gets one reminder)
//   'morning_of' due later today, sent from 7:00 AM Eastern on

const { dueAt, easternNow, isoDate } = require('./bid_due');
const { sendBidReminder } = require('./email');

const INTERVAL_MIN = 5;
const MORNING_HOUR = 7;

function settingsFor(db, userId) {
  const row = db.prepare('SELECT * FROM user_reminder_settings WHERE user_id = ?').get(userId);
  return row || { user_id: userId, email_24h: 1, push_24h: 1, morning_of: 0, admin_copy: 0 };
}

function openBids(db) {
  return db.prepare(`
    SELECT c.id AS entry_id, c.project_name, c.client_gc, c.due_date AS bid_date, c.due_time AS bid_time,
           c.assigned_to AS created_by,
           e.id AS estimate_id, e.bid_number, IFNULL(e.status, 'Not started') AS status,
           u.email AS owner_email, u.name AS owner_name, u.active AS owner_active
    FROM bid_calendar c
    LEFT JOIN estimates e ON e.id = c.estimate_id AND e.deleted_at IS NULL
    LEFT JOIN users u ON u.id = c.assigned_to
    WHERE c.deleted_at IS NULL
      AND c.due_date IS NOT NULL AND c.due_date != ''
      AND c.due_time IS NOT NULL AND c.due_time != ''
      AND (e.id IS NULL OR e.status = 'Draft')
  `).all();
}

function adminCopyUsers(db) {
  return db.prepare(`
    SELECT u.id, u.email, u.name FROM users u
    JOIN user_reminder_settings s ON s.user_id = u.id
    WHERE u.active = 1 AND u.role IN ('admin','superadmin') AND s.admin_copy = 1
  `).all();
}

async function runOnce(db) {
  const now = new Date();
  const { date: today, hour } = easternNow(now);
  let bids;
  try { bids = openBids(db); } catch (err) { console.error('[reminders] query failed:', err.message); return; }
  const admins = adminCopyUsers(db);
  const already = db.prepare('SELECT 1 FROM calendar_reminders WHERE entry_id = ? AND user_id = ? AND kind = ? AND due_at = ?');
  // A bid copied over from the v1 calendar may already have had this exact
  // reminder sent under its estimate. Do not send it a second time.
  const alreadyV1 = db.prepare('SELECT 1 FROM bid_reminders WHERE estimate_id = ? AND user_id = ? AND kind = ? AND due_at = ?');
  const log = db.prepare('INSERT OR IGNORE INTO calendar_reminders (entry_id, user_id, kind, due_at, result) VALUES (?, ?, ?, ?, ?)');

  for (const b of bids) {
    const due = dueAt(b.bid_date, b.bid_time);
    if (!due) continue;
    // The email links to the estimate when there is one, else to the calendar.
    b.id = b.estimate_id;
    b.link_path = b.estimate_id ? '/#/estimate/' + b.estimate_id : '/#/calendar';
    const msLeft = due.getTime() - now.getTime();
    if (msLeft <= 0) continue; // already due; nothing to remind about
    const dueIso = due.toISOString();

    const kinds = [];
    if (msLeft <= 24 * 3600 * 1000) kinds.push('24h');
    if (isoDate(b.bid_date) === today && hour >= MORNING_HOUR) kinds.push('morning_of');
    if (!kinds.length) continue;

    // Who gets it: the estimator on the bid, plus admins who opted into copies.
    const targets = [];
    if (b.created_by && b.owner_email && b.owner_active) {
      targets.push({ id: b.created_by, email: b.owner_email, name: b.owner_name, settings: settingsFor(db, b.created_by), owner: true });
    }
    for (const a of admins) {
      if (a.id === b.created_by) continue;
      targets.push({ id: a.id, email: a.email, name: a.name, settings: settingsFor(db, a.id), owner: false });
    }

    for (const kind of kinds) {
      for (const t of targets) {
        const wants = kind === '24h' ? !!t.settings.email_24h : !!t.settings.morning_of;
        if (!wants) continue;
        if (already.get(b.entry_id, t.id, kind, dueIso)) continue;
        if (b.estimate_id && alreadyV1.get(b.estimate_id, t.id, kind, dueIso)) continue;
        let result;
        try {
          const r = await sendBidReminder(t.email, t.name, b, kind, t.owner);
          result = r && r.ok ? 'sent' : ('skipped: ' + (r && (r.skipped || r.error) || 'unknown'));
        } catch (err) {
          result = 'error: ' + (err.message || err);
        }
        // A send error is not logged, so the next pass retries it. A skip (email
        // not configured) is logged, so a later config change does not release a
        // flood of stale reminders.
        if (!result.startsWith('error:')) log.run(b.entry_id, t.id, kind, dueIso, result);
        console.log(`[reminders] ${kind} calendar bid ${b.entry_id}${b.bid_number ? ' (#' + b.bid_number + ')' : ''} -> ${t.email}: ${result}`);
      }
    }
  }
}

function start(db) {
  if (process.env.BID_REMINDERS === 'off') { console.log('[reminders] disabled by BID_REMINDERS=off'); return; }
  // First pass shortly after boot so a redeploy never skips a window.
  setTimeout(() => runOnce(db).catch(err => console.error('[reminders]', err)), 20 * 1000).unref?.();
  setInterval(() => runOnce(db).catch(err => console.error('[reminders]', err)), INTERVAL_MIN * 60 * 1000).unref?.();
  console.log('[reminders] bid due reminders every ' + INTERVAL_MIN + ' min');
}

module.exports = { start, runOnce };

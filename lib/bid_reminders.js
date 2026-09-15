'use strict';
// Bid due-date reminders. Runs on a timer inside the API process.
//
// Every few minutes: find open bids with a due date AND time, and for each one
// that is inside its reminder window, email the estimator (and any admin who
// asked for copies). bid_reminders records every send so a restart or a second
// replica can never send the same reminder twice. Nothing here touches the
// estimate rows themselves.
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
    SELECT e.id, e.bid_number, e.project_name, e.client_gc, e.bid_date, e.bid_time, e.status, e.created_by,
           u.email AS owner_email, u.name AS owner_name, u.active AS owner_active
    FROM estimates e
    LEFT JOIN users u ON u.id = e.created_by
    WHERE e.deleted_at IS NULL AND e.confirmed = 1 AND e.is_alternate = 0 AND e.change_order_id IS NULL
      AND (e.bid_type = 'real' OR e.bid_type IS NULL)
      AND e.status IN ('Draft')
      AND e.bid_date IS NOT NULL AND e.bid_date != ''
      AND e.bid_time IS NOT NULL AND e.bid_time != ''
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
  const already = db.prepare('SELECT 1 FROM bid_reminders WHERE estimate_id = ? AND user_id = ? AND kind = ? AND due_at = ?');
  const log = db.prepare('INSERT OR IGNORE INTO bid_reminders (estimate_id, user_id, kind, due_at, result) VALUES (?, ?, ?, ?, ?)');

  for (const b of bids) {
    const due = dueAt(b.bid_date, b.bid_time);
    if (!due) continue;
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
        if (already.get(b.id, t.id, kind, dueIso)) continue;
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
        if (!result.startsWith('error:')) log.run(b.id, t.id, kind, dueIso, result);
        console.log(`[reminders] ${kind} bid #${b.bid_number || b.id} -> ${t.email}: ${result}`);
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

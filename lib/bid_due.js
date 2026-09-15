'use strict';
// Shared helpers for the Bid Calendar and its reminders.
//
// bid_date is stored two ways in old rows ('M/D/YYYY') and new rows
// ('YYYY-MM-DD'); bid_time is always 'HH:MM' (24h) and always Eastern, because
// every GC R&R bids to is in the Eastern zone. The server runs in UTC, so the
// due moment has to be built with the Eastern offset in effect on that day.

const ZONE = 'America/New_York';

// Normalize any stored bid_date to 'YYYY-MM-DD'. Returns '' when unusable.
function isoDate(s) {
  if (!s) return '';
  const str = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const d = new Date(str);
  if (isNaN(d)) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 'HH:MM' or ''. Accepts 'H:MM' and trims seconds.
function isoTime(s) {
  if (!s) return '';
  const m = String(s).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '';
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return '';
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

// Minutes that Eastern is offset from UTC at the given instant (negative, e.g. -240 in summer).
function easternOffsetMinutes(at) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(at);
  const g = {};
  for (const p of parts) g[p.type] = p.value;
  const asUtc = Date.UTC(+g.year, +g.month - 1, +g.day, +g.hour, +g.minute, +g.second);
  return Math.round((asUtc - at.getTime()) / 60000);
}

// The instant a bid is due, as a Date, or null when date or time is missing.
function dueAt(bidDate, bidTime) {
  const d = isoDate(bidDate), t = isoTime(bidTime);
  if (!d || !t) return null;
  const guess = new Date(`${d}T${t}:00Z`);
  if (isNaN(guess)) return null;
  // Interpret the wall-clock value as Eastern: subtract the offset in effect.
  let out = new Date(guess.getTime() - easternOffsetMinutes(guess) * 60000);
  // Re-check with the corrected instant in case the guess straddled a DST change.
  out = new Date(guess.getTime() - easternOffsetMinutes(out) * 60000);
  return out;
}

// Today's date in Eastern as 'YYYY-MM-DD', and the Eastern hour (0-23).
function easternNow(at = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit'
  }).formatToParts(at);
  const g = {};
  for (const p of parts) g[p.type] = p.value;
  return { date: `${g.year}-${g.month}-${g.day}`, hour: +g.hour };
}

// 'Fri Sep 18 at 10:00 AM' for emails and notifications.
function friendlyDue(bidDate, bidTime) {
  const d = isoDate(bidDate), t = isoTime(bidTime);
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  const dayStr = new Date(Date.UTC(y, m - 1, day, 12)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  if (!t) return dayStr;
  const [h, mi] = t.split(':').map(Number);
  const tStr = `${h % 12 || 12}:${String(mi).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  return `${dayStr} at ${tStr}`;
}

module.exports = { isoDate, isoTime, dueAt, easternNow, friendlyDue, ZONE };

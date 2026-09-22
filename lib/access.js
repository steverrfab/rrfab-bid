'use strict';
// Per-user page access.
//
// Admins decide which pages each person sees. The choice is stored on the user
// as a JSON list of page keys in users.page_access. NULL means "use the role's
// defaults", which are exactly what each role could see before this feature
// existed, so nobody's access changes until an admin changes it.
//
// A superadmin defaults to every page and is the only person who can change
// their own list, from the Users screen. Settings (including Users) is not one
// of these pages, so a superadmin who unticks everything can always get back in
// and turn pages on again.
//
// The Project Tracker button is not in this list: it is already controlled per
// user by tracker_role.
const db = require('../db');

const PAGES = [
  { key: 'dashboard',     label: 'Dashboard' },
  { key: 'estimates',     label: 'Estimates' },
  { key: 'calendar',      label: 'Bid Calendar' },
  { key: 'change_orders', label: 'Change Orders' },
  { key: 'reports',       label: 'Reports' },
  { key: 'tax',           label: 'Tax Tracker' },
  { key: 'trash',         label: 'Deleted Bids' },
];
const PAGE_KEYS = PAGES.map(p => p.key);

const ROLE_DEFAULTS = {
  superadmin: PAGE_KEYS,
  admin: PAGE_KEYS,
  estimator: ['dashboard', 'estimates', 'calendar', 'change_orders', 'trash'],
};

function defaultsFor(role) {
  return (ROLE_DEFAULTS[role] || ROLE_DEFAULTS.estimator).slice();
}

// Parse a stored value. Anything unreadable counts as "no custom list".
function parseStored(raw) {
  if (raw == null || raw === '') return null;
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return null;
    return PAGE_KEYS.filter(k => v.includes(k));
  } catch {
    return null;
  }
}

// Clean an incoming list from the Users screen. Returns null for "defaults",
// an array for a custom list, or undefined when the input is not usable.
function cleanIncoming(v) {
  if (v === null) return null;
  if (!Array.isArray(v)) return undefined;
  if (v.some(k => !PAGE_KEYS.includes(k))) return undefined;
  return PAGE_KEYS.filter(k => v.includes(k));
}

function effectivePages(user) {
  if (!user) return [];
  const custom = parseStored(user.page_access);
  return custom || defaultsFor(user.role);
}

function pagesForUserId(userId) {
  let row;
  try {
    row = db.prepare('SELECT role, page_access FROM users WHERE id = ?').get(userId);
  } catch {
    // Column not there yet (migration still to run): fall back to the role.
    row = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  }
  return effectivePages(row);
}

function canSee(req, page) {
  if (!req.user || !req.user.userId) return false;
  return pagesForUserId(req.user.userId).includes(page);
}

const DENIED = { error: 'You do not have access to this page. Ask an admin to turn it on for you.' };

function requirePage(page) {
  return (req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    if (!canSee(req, page)) return res.status(403).json(DENIED);
    next();
  };
}

// Project Tracker level. A superadmin always has the tracker, as Admin unless
// a level was picked for them, so the account in charge is never locked out.
function effectiveTrackerRole(user) {
  if (!user) return 'none';
  const r = user.tracker_role || 'none';
  if (user.role === 'superadmin' && r === 'none') return 'admin';
  return r;
}

// CRM level. Unlike the tracker, a superadmin is NOT given this automatically:
// the CRM is a separate product with its own accounts, and a bid tool admin who
// has no CRM account would only get an error by clicking through. An admin turns
// it on per person, which is also how "just Joe for now" is expressed.
function effectiveCrmRole(user) {
  if (!user) return 'none';
  return user.crm_role || 'none';
}

module.exports = { effectiveTrackerRole, effectiveCrmRole, PAGES, PAGE_KEYS, defaultsFor, parseStored, cleanIncoming, effectivePages, pagesForUserId, canSee, requirePage, DENIED };

'use strict';
// One place to check the shared secrets other tools use to talk to this API
// (TRACKER_KEY, BACKUP_KEY, FEEDBACK_KEY). Before this, each route compared its
// own key its own way, and two of the three were not timing-safe.
//
// Both sides are hashed first so the comparison always runs over equal-length
// buffers, which is what crypto.timingSafeEqual needs. An unset or empty key
// never matches anything, so an unconfigured deploy refuses every request.
const crypto = require('crypto');

function keyMatches(expected, provided) {
  const want = String(expected || '');
  const got = String(provided || '');
  if (!want || !got) return false;
  const a = crypto.createHash('sha256').update(want).digest();
  const b = crypto.createHash('sha256').update(got).digest();
  return crypto.timingSafeEqual(a, b);
}

// True when the request's X-Integration-Key header matches the named env var.
function integrationKeyOk(req, envName) {
  return keyMatches(process.env[envName], req.get('X-Integration-Key'));
}

// Express guard. Response shape defaults to the one the tracker feeds have
// always returned, so nothing that calls these endpoints sees a change.
function requireIntegrationKey(envName, status = 401, body = { error: 'invalid integration key' }) {
  return (req, res, next) => {
    if (!integrationKeyOk(req, envName)) return res.status(status).json(body);
    next();
  };
}

module.exports = { keyMatches, integrationKeyOk, requireIntegrationKey };

'use strict';
// Offline restore drill. Reads a downloaded archive and manifest and creates a
// NEW verified database file. Never loads the app or overwrites any database.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { gunzipSync } = require('zlib');
const { inspectDatabase } = require('../lib/backblaze_backup');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const MAX_BYTES = 128 * 1024 * 1024;

function verifyArchive(archivePath, manifestPath, outputPath) {
  if (fs.existsSync(outputPath)) throw new Error('Output already exists; choose a new file');
  if (fs.statSync(archivePath).size > MAX_BYTES + 1024 * 1024) throw new Error('Archive exceeds the restore size limit');
  if (fs.statSync(manifestPath).size > 1024 * 1024) throw new Error('Manifest exceeds the size limit');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.format !== 'rrfab-bid-sqlite-gzip-v1') throw new Error('Unrecognized backup format');
  const archive = fs.readFileSync(archivePath);
  if (archive.length !== manifest.archiveBytes || hash(archive) !== manifest.archiveSha256) {
    throw new Error('Archive checksum or size mismatch');
  }
  const raw = gunzipSync(archive, { maxOutputLength: MAX_BYTES });
  if (raw.length !== manifest.databaseBytes || hash(raw) !== manifest.databaseSha256) {
    throw new Error('Database checksum or size mismatch');
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rrbid-b2-verify-'));
  try {
    const tempFile = path.join(tempDir, 'restore.db');
    fs.writeFileSync(tempFile, raw, { mode: 0o600 });
    const summary = inspectDatabase(tempFile);
    if (summary.userVersion !== manifest.userVersion ||
        JSON.stringify(summary.tableRowCounts) !== JSON.stringify(manifest.tableRowCounts)) {
      throw new Error('Database contents do not match the manifest');
    }
    fs.writeFileSync(outputPath, raw, { flag: 'wx', mode: 0o600 });
    return summary;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const [archivePath, manifestPath, outputPath] = process.argv.slice(2);
  if (!archivePath || !manifestPath || !outputPath) {
    console.error('Usage: node scripts/verify_b2_backup.js archive.db.gz archive.manifest.json NEW-output.db');
    process.exitCode = 1;
  } else {
    try {
      const summary = verifyArchive(archivePath, manifestPath, outputPath);
      console.log('Verified new restore file. Integrity: ok. Tables: ' + Object.keys(summary.tableRowCounts).length);
    } catch (err) { console.error(err.message); process.exitCode = 1; }
  }
}
module.exports = { verifyArchive };

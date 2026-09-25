# R&R Bid: independent Backblaze backups

This is an opt-in addition to the existing hourly SharePoint backup. No bids,
prices, users, or database schema are modified. The app uses SQLite, not
PostgreSQL; a plain copy of the live WAL-mode database is not a safe backup.

## Configuration

Set these only on the existing production `rrfab-bid` Railway service. Keep the
key secret in Railway service variables; never commit it or paste it into chat.

| Variable | Value / purpose |
| --- | --- |
| `B2_BACKUP_ENABLED` | `true` to activate; absent/false does nothing |
| `B2_BACKUP_ENDPOINT` | `https://s3.us-east-005.backblazeb2.com` |
| `B2_BACKUP_REGION` | `us-east-005` |
| `B2_BACKUP_BUCKET` | `steve-software-backups-20260925` |
| `B2_BACKUP_PREFIX` | `projects/rrfab-bid/` |
| `B2_BACKUP_KEY_ID` | Dedicated application key ID |
| `B2_BACKUP_SECRET` | Dedicated application key secret |
| `B2_BACKUP_UTC_TIME` | `06:17` (02:17 Eastern daylight time; 01:17 standard time) |
| `B2_BACKUP_ALERT_TO` | One explicitly approved owner's email; omit to disable emails |
| `DATA_DIR` | Existing mounted volume; keep its current value |

Email alerts use the app's existing Microsoft Graph or SMTP configuration.
Existing `BACKUP_SP_*`, `BACKUP_KEY`, and `AZURE_*` values remain unchanged.
No second Railway service, subscription, or dependency is required.

Use a standard B2 key restricted to the named bucket and exact project prefix.
The job only requires object PUT and GET. Prefer a custom key with `readFiles`
and `writeFiles` (plus required bucket/list capabilities for the chosen client)
without deletion or key/bucket administration. The web console's Read and Write
preset can include more capabilities, including deletion; record the returned
capabilities honestly. Do not create/use a master key for this job. Do not enable
List All Bucket Names; this client addresses its configured bucket directly.

## Operation and cost controls

After startup the service checks for a due run after 30 seconds, then every
minute. At 06:17 UTC it makes a consistent SQLite online snapshot, compresses it,
and uploads a full daily copy. The first run also creates weekly and monthly
copies; later weeks (Monday) and months get their own first successful snapshot.
If the service was down at the scheduled time it catches up when it resumes.
It does not recreate historical days that were missed.

`DATA_DIR/b2-backup-state.json` records non-secret last-success and period
metadata, avoiding duplicate uploads after a redeploy. Losing this metadata
causes a fresh set of copies. Only one job runs at a time in this process; this
design assumes the existing single Railway replica and its attached volume.

Each saved `.db.gz` is downloaded, compared by SHA-256, decompressed into a
temporary file, opened read-only, and checked with SQLite `integrity_check` and
all user-table row counts. The companion `.manifest.json` contains checksums,
size, table counts, and timestamps and is also downloaded and verified. Neither
the app nor its migration code is run against the restored copy.

```
projects/rrfab-bid/database/daily/rrfab-bid_<UTC timestamp>.db.gz
projects/rrfab-bid/database/daily/rrfab-bid_<UTC timestamp>.manifest.json
projects/rrfab-bid/database/weekly/...
projects/rrfab-bid/database/monthly/...
```

The bucket is private and encrypted; every upload also requests AES256 SSE-B2.
Requests require HTTPS, do not follow redirects, have a 30-second timeout, and
retry transient failures up to three attempts. Failed jobs retry after 15
minutes. Database size is limited to 128 MiB to bound memory use; exceeding it
fails visibly and requires a capacity review, not silent truncation.

**Retention is currently keep all versions. This job never deletes remote
files.** Proposed daily 30-day / weekly 84-day / monthly 365-day expiry requires
separate approval before exact-prefix B2 lifecycle rules are enabled. Apply
the same tier rules to archives and manifests. Keep the account's $0 caps and
usage alerts; reaching a free cap can stop new backups. Storage is shared with
other projects. Review growth rather than raising caps automatically.

The production database was about 1.88 MB before compression on 2026-09-25.
Even a year of full daily/weekly/monthly copies at that fixed size is below
1 GB before compression; future growth and other projects still count.

## Status and failure notifications

The existing authenticated `GET /api/backup/status` includes `backblaze`, with
last attempt, verified success, object names, and safe error messages. Continue
using the existing backup key in a request header, never in a URL. The legacy
`offsite` field still reports SharePoint separately. Logs use `[b2-backup]`.

With an approved alert recipient, the first failure sends a short email; repeated
failures send at most once per 24 hours, with a recovery message after a verified
success. Failed email delivery is exposed in `lastAlertError` and the logs.
Messages contain status only, no database contents or credentials.

**This in-service scheduler cannot send alerts while Railway/the app is stopped
or the volume is lost.** An independent freshness monitor is still needed to
detect that condition. Until one is configured, periodically check the B2 file
dates and the verified-success timestamp. Do not equate a healthy web page with
a recent verified backup.

## File coverage

The service's durable business data is `DATA_DIR/rrbid.db`. Estimate spreadsheet
imports are parsed from memory into SQLite; original uploads are not saved on
the server. Proposal/report PDFs are generated on demand. Feedback text is in
SQLite, but feedback attachments are only emailed and are not persisted on this
volume. Protect those email attachments through the mail system separately.
This job therefore uploads database snapshots, not a fictitious server file
archive. Revisit coverage if persistent uploads are added later.

## Recovery drill (safe, separate from production)

1. Sign into B2 with the account owner, or use separately controlled read access.
2. Download a `.db.gz` and its matching `.manifest.json` from the same tier/date.
3. In a trusted copy of this repository with its Node 20 dependencies installed:

   ```text
   node scripts/verify_b2_backup.js downloaded.db.gz downloaded.manifest.json NEW-restored.db
   ```

   This verifies checksums, size, SQLite integrity and table counts. The output
   must be a new file; it refuses to overwrite any existing database. It does
   not start the app, execute migrations, email anyone or alter the live volume.

4. Inspect the new database read-only and verify representative recent bids.
5. For a real production recovery, obtain explicit approval to pause writes and
   replace data. Preserve the damaged database and its WAL/SHM files first.
   Restore with all application writers stopped; never pair the restored file
   with stale live WAL/SHM files. Use the appropriate source version, verify
   access and bid totals, and only then reopen the app.
6. Rebuild the service from GitHub using `railway.json` and its documented
   variables. Secrets such as JWT, Azure, integration, QBO and backup keys belong
   in a controlled secret store, not in the bucket's plaintext instructions.

Disabling `B2_BACKUP_ENABLED` stops new B2 jobs after a redeploy. It does not
remove saved copies or change the independent SharePoint job.

## Validation before activation

The local suite exercises real WAL-mode snapshots and restores, daily/weekly/
monthly boundaries, persisted scheduling, corrupt downloads, HTTP failures,
retries, notification throttling, overlap prevention and restore overwrite
refusal. These tests use a local object-store stand-in and fake credentials.
Activation is not complete until a production B2 upload, download/restore
verification and recorded success are observed with the restricted live key.

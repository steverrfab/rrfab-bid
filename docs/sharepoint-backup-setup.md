# Backing the bid database up to SharePoint

The whole company's estimating history is one SQLite file on one Railway volume,
on a plan with no volume backups. This puts a fresh copy into SharePoint on a
timer, so losing that volume costs one hour of work instead of everything.

The code is written and deployed. What is left is switching it on.

---

## Before anything: where these files should live

**The backup file contains everything.** Every bid, every customer, and the
`users` table including password hashes. Anyone who can open the file can read
all of it.

So do **not** put it in `estimating-365-group` or anywhere the estimating team
can browse. Make a new SharePoint site that only you and anyone else who already
has full access to the bid tool can see.

Suggested: a private team site called **Bid Tool Backups**, and inside its
Documents library the backup code will make its own dated folders.

---

## Step 1 — Make the site

1. Go to https://rnrfabrication.sharepoint.com
2. **Create site** → **Team site**
3. Name it `Bid Tool Backups`. The address becomes
   `https://rnrfabrication.sharepoint.com/sites/BidToolBackups`
4. Set privacy to **Private**. Add no members beyond yourself for now.

Write down the last part of the address (`BidToolBackups`) — Step 4 needs it.

---

## Step 2 — Let the existing app write to SharePoint

The bid tool already has an app registration in Entra; it is what sends proposal
emails. It is being reused, so there are no new credentials to look after.

1. Go to https://entra.microsoft.com
2. **Applications** → **App registrations** → **All applications**
3. Find the app whose **Application (client) ID** matches the `AZURE_CLIENT_ID`
   value in Railway (Backend service → Variables). Open it.
4. **API permissions** → **Add a permission** → **Microsoft Graph** →
   **Application permissions**
5. Search for `Sites.Selected`, tick it, **Add permissions**
6. Back on the list, click **Grant admin consent for R&R Fabrication** and
   confirm. `Sites.Selected` should then show a green tick.

**Why `Sites.Selected` and not `Sites.ReadWrite.All`:** `Sites.Selected` grants
nothing on its own. It only lets the app reach sites it has been explicitly given,
which is what Step 3 does. `Sites.ReadWrite.All` would let the app write to every
site in the company. Given what is in this file, the narrow one is worth the extra
step.

---

## Step 3 — Give the app that one site

`Sites.Selected` needs the site handed over deliberately. There is no button for
this in the portal; it is one call in Graph Explorer.

1. Go to https://developer.microsoft.com/graph/graph-explorer
2. Sign in top-right as **stevem@rrfabrication.org**
3. Run this as a **GET** to find the site's ID:

   ```
   https://graph.microsoft.com/v1.0/sites/rnrfabrication.sharepoint.com:/sites/BidToolBackups
   ```

   In the response, copy the `id` field. It is a long comma-separated string.

4. Change the method to **POST** and the URL to (using that id):

   ```
   https://graph.microsoft.com/v1.0/sites/{PASTE-THE-ID}/permissions
   ```

5. On the **Request body** tab, paste this, replacing `{AZURE_CLIENT_ID}` with
   the client ID from Step 2:

   ```json
   {
     "roles": ["write"],
     "grantedToIdentities": [{
       "application": {
         "id": "{AZURE_CLIENT_ID}",
         "displayName": "RR Bid Tool"
       }
     }]
   }
   ```

6. **Run query**. A `201 Created` means it worked.

If Graph Explorer says you lack consent, use the **Modify permissions** tab on
the left and consent to `Sites.FullControl.All` for *yourself* — that is your own
delegated permission for this one-off, not the app's.

---

## Step 4 — Switch it on in Railway

Backend service (`rrfab-bid`) → **Variables** → add:

| Variable | Value |
|---|---|
| `BACKUP_SP_SITE` | `rnrfabrication.sharepoint.com:/sites/BidToolBackups` |
| `BACKUP_SP_FOLDER` | `Backups` *(optional; defaults to `BidToolBackups`)* |
| `BACKUP_INTERVAL_MIN` | `60` *(optional; defaults to 60)* |

`AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` are already set and
are reused as-is.

Saving these redeploys the backend.

---

## Step 5 — Check it actually worked

A backup you believe is running and is not is worse than no backup, so confirm:

**In the Railway deploy logs**, within about thirty seconds of startup:

```
[offsite] off-site backup on, every 60 minute(s), to SharePoint rnrfabrication.sharepoint.com:/sites/BidToolBackups
[offsite] backed up 1543168 bytes to SharePoint .../Backups/2026/09/03/rrbid-2026-09-03T...db
```

If something is wrong it will say so loudly, starting with `BACKUP FAILED`.

**In SharePoint**, the file appears under
`Bid Tool Backups → Documents → Backups → 2026 → 09 → 03`.

**Or ask the app**, which reports its own backup state:

```
GET https://rrfab-bid-production.up.railway.app/api/backup/status
Header:  X-Integration-Key: <the BACKUP_KEY value from Railway>
```

`lastSuccessAt` should be recent, `lastError` should be `null`, and `destination`
should read `sharepoint`.

---

## Housekeeping

**Old copies are never deleted by the bid tool.** That is deliberate — a bug in
delete code is exactly the thing worth avoiding when the subject is backups. At
roughly 1.5 MB an hour this is about 1 GB a year, which is nothing against a
SharePoint quota, but set a retention policy on the library if you want it tidy.

**Restoring:** download the `.db` file, put it on the Railway volume at
`/app/data/rrbid.db` with the app stopped, and start it again. Worth doing once
as a drill, on a copy, before you ever need it for real.

---

## If you would rather not do the Azure steps

The same code supports S3-compatible storage instead — Cloudflare R2, Backblaze
B2, AWS S3. That needs four variables (`BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`,
`BACKUP_S3_KEY_ID`, `BACKUP_S3_SECRET`) and no Azure work at all. It is about ten
minutes and free at this size. The trade is another vendor account, and the file
is not somewhere you can browse from Explorer.

Whichever is configured is the one used. If both are, SharePoint wins.

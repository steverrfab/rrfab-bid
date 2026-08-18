# rrfab-bid

Node.js/Express backend for the R&R Bid Tool. SQLite, SQL migrations in
`migrations/`, deployed on Railway. Frontend is `steverrfab/rrfab-bid-frontend`.

---

## RULE 1: Every user-facing change updates What's New. No exceptions.

**The changelog lives in the frontend repo, at
`rrfab-bid-frontend/src/pages/WhatsNew.jsx`.** Backend work does not get a pass
because the file is somewhere else.

If a change here alters anything a user can see or feel — pricing, a weight, a
PDF, an import, an email, a saved value, a total on a dashboard — then a
matching What's New entry is written in the frontend repo and **both commits
ship together**. A backend commit that changes behavior without one is an
incomplete commit.

This applies to a fix, a bug, a tweak, a new feature, a one-line correction.
Steve has had to ask for this repeatedly.

Purely internal work with no visible effect (refactors, logging, comments,
dependency bumps) does not need an entry.

See the frontend `CLAUDE.md` for the entry format. The key requirement:
**state plainly whether existing bids are affected.** If old bids reprice, lead
with it. If they are untouched, say so explicitly.

---

## RULE 2: Never silently reprice a bid that has already gone out.

This has happened and it cost real trust. `lib/calc.js` produces the numbers
that were sent to GCs. "Improving" a weight lookup reaches backwards into every
bid in the system, including submitted ones.

- Fix bad data **at import**, not in the calculation.
- `plateUnitWeight` and `legacyPlateUnitWeight` must keep producing their
  original numbers. There are comments saying so. Read them.
- `takeoff_plates.weight_lb` means "this is the weight that was quoted, use it
  as it stands." Editing a row's thickness, width, length or qty clears it and
  hands that row back to the current calculation — deliberately, one row at a
  time.
- A migration that rewrites existing rows needs to be raised with Steve **before**
  it is written, not reported after it deploys.

---

## RULE 3: Clone is a copy. Never a revision.

Cloning exists to send the same bid to multiple GCs on the same project.
Everything transfers except bid identity (bid number, job number, contractor).
Clone must never modify the source bid. It previously marked the original
`superseded`, dropping a live bid out of dashboard totals.

Child tables are discovered dynamically — anything with an `estimate_id` column
comes across unless it is named in `CLONE_SKIP_TABLES`. Do not go back to a
hardcoded table list; it went stale every time the schema moved.

---

## Before writing any code

Check `git log origin/main`, the branch list, and **the open PR list on both
repos**. On 2026-08-04 both repos moved mid-session and a full day of work was
rebuilt from scratch for nothing.

## Working with Steve

- He does not read code. Verify mechanically, report in plain language.
- Short answers. He will ask for detail if he wants it.
- Always distinguish changes that touch **existing data** from changes that only
  add new things.

## Conventions

- Migrations are numbered SQL files in `migrations/`. One-time data fixes are
  guarded by the `_data_fixes` table so they run once, not on every deploy.
- Integration auth follows the existing `TRACKER_KEY` / `X-Integration-Key`
  pattern.
- Syntax check before committing: `node --check path/to/file.js`
- The repo is public and can be run locally against a throwaway `DATA_DIR` on a
  spare port. Doing that has caught real bugs that reading the code did not.

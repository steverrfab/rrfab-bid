# R&R Bid Tool: Business Rules

These are the rules the bid tool already follows today. Nothing here is new.
Each rule is copied from the repo instructions (CLAUDE.md) or from the code
that enforces it. The source is listed so anyone can check it.

Any change to these rules needs Steve's approval first.

---

## 1. Bid invites and the Bid Calendar

- **An invite goes on the Bid Calendar first.** An estimator adds it when a GC
  email or bid board invite comes in, before any estimate exists.
  *(routes/calendar.js)*
- **A calendar entry holds:** project name, GC, source, due date, due time,
  start lead time, assigned estimator, plans link, notes. *(migration 062)*
- **Allowed sources:** Email, BuildingConnected, PlanHub, Procore, Phone, Other.
  *(routes/calendar.js)*
- **Start date is counted back from the due date** by 2, 3 or 5 business days.
  Default is 2. Weekends do not count. *(routes/calendar.js)*
- **One estimate per calendar entry.** Each GC gets its own entry and its own
  estimate. *(migration 062, routes/calendar.js)*
- **The due date follows the calendar.** Changing the date on the calendar
  changes it on the linked estimate. Nothing else on the estimate is touched.
  *(routes/calendar.js)*
- **Removing a calendar entry never touches the estimate.** *(routes/calendar.js)*

## 2. Starting a project

- **Start bid** on a calendar entry creates a new estimate with project, GC and
  due date filled in, status Draft, owned by the assigned estimator, and links
  it to the entry. *(routes/calendar.js)*
- **Job type is Full or Process Only.** Process Only estimates get the standard
  Process Only line items and added costs. *(routes/estimates.js)*
- **Every new estimate starts with:** Prepared By set to the owner, the admin's
  default proposal Notes and Terms, and the current company wage rates.
  *(routes/estimates.js)*
- **Copy for this GC** copies another GC's estimate on the same job into a new
  estimate with its own bid number. The original is not changed.
  *(routes/calendar.js)*

## 3. Bid numbers and job numbers

- **Bid numbers are one shared series** for all job types. The next number is
  the highest used plus 1, starting at 2000. *(routes/estimates.js)*
- **Revisions add a suffix:** 2000.1, 2000.2, and so on. *(routes/estimates.js)*
- **A bid number is assigned at Start bid, or on first save** for an estimate
  created directly. Change order estimates never take a bid number.
  *(routes/calendar.js, routes/estimates.js)*
- **A bid cannot be marked Won without a valid, unique job number.**
  Full jobs: 1234-5678. Process Only: P-000, optionally -1, -2, -3 for phases.
  *(routes/estimates.js)*
- **Status belongs to the whole job.** Changing status on one version moves
  every version with the same bid number base. *(routes/estimates.js)*

## 4. Protecting bids that went out

- **Never silently reprice a bid that has already gone out.** *(CLAUDE.md, Rule 2)*
- **Fix bad data at import, not in the calculation.** *(CLAUDE.md, Rule 2)*
- **A quoted plate weight stands as quoted.** Editing that row's size or qty
  hands that one row back to the current calculation. *(CLAUDE.md, Rule 2)*
- **Any change that rewrites existing rows is raised with Steve before it is
  written.** *(CLAUDE.md, Rule 2)*
- **All bid math comes from one place** (the calculation module).
  *(README.md)*

## 5. Clone

- **Clone is a copy, never a revision.** It exists to send the same bid to
  multiple GCs. *(CLAUDE.md, Rule 3)*
- **Everything copies except bid identity:** bid number, job number, contractor.
  *(CLAUDE.md, Rule 3)*
- **Clone never changes the original bid.** *(CLAUDE.md, Rule 3)*
- **Not copied:** edit locks, resubmit history, change orders, schedule of
  values. *(routes/estimates.js)*

## 6. Client Proposal PDF

- **Nothing prints on the PDF that is not shown and editable on the Client
  Proposal screen first.** *(frontend CLAUDE.md, Rule 2)*

## 7. Editing

- **One person edits an estimate at a time.** A lock frees itself after 2
  minutes of no activity. Admins can force-release it. *(routes/estimates.js)*

## 8. Change log and communication

- **Every change a user can see gets a What's New entry**, in the same release,
  including backend changes. *(both CLAUDE.md files, Rule 1)*
- **Every entry says plainly whether existing bids are affected.** If old bids
  reprice, that comes first. *(frontend CLAUDE.md)*
- **Every report distinguishes changes to existing data from new additions.**
  *(both CLAUDE.md files)*

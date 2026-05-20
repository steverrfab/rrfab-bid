# R&R Bid - Backend

Estimating and bid management for R&R Fabrication.

Part of the R&R OS ecosystem. Replaces the old Excel bid template + SteelQuote Pro with a single integrated tool.

## Stack

- Node.js + Express
- better-sqlite3 (file-backed, persisted on Railway volume)
- ExcelJS (takeoff upload parser)
- Multer (file uploads)

## Local dev

```bash
npm install
node server.js
```

Server starts on http://localhost:3000. Database is created at `./data/rrbid.db`. AISC database (635 sections) is seeded automatically on first boot.

Verify it's up:

```bash
curl http://localhost:3000/api/health
```

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | Service health check |
| GET | `/api/aisc?q=W6` | Section autocomplete |
| GET | `/api/aisc/lookup?section=W6X25` | Single section weight lookup |
| GET | `/api/estimates` | List all estimates |
| POST | `/api/estimates` | Create new estimate |
| GET | `/api/estimates/:id` | Full estimate bundle (inputs + computed totals) |
| PUT | `/api/estimates/:id` | Update estimate fields |
| DELETE | `/api/estimates/:id` | Delete estimate |
| POST | `/api/estimates/:id/clone` | Duplicate estimate |
| PUT | `/api/estimates/:id/material/:section` | Set/clear material override |
| PUT | `/api/estimates/:id/takeoff/shapes` | Replace shape takeoff rows |
| PUT | `/api/estimates/:id/takeoff/plates` | Replace plate takeoff rows |
| POST | `/api/estimates/:id/takeoff/upload` | Upload .xlsx template, parse + insert |
| POST | `/api/estimates/:id/submit` | Mark submitted, stamp timestamp |
| GET | `/api/template/takeoff` | Download takeoff Excel template |

## Database layout

| Table | What it holds |
|---|---|
| `estimates` | One row per estimate. All flat inputs (Cost Inputs, Markup, Tax, LJB, Proposal text) |
| `material_overrides` | Per-section manual weight/$/CWT entries that override the takeoff |
| `takeoff_shapes` | Takeoff rows for W/WT/HSS/C/MC/L/2L/S/Pipe |
| `takeoff_plates` | Takeoff rows for plates (different schema) |
| `wage_rates` | Per-estimate per-role wage burden inputs |
| `aisc_sections` | 635-row reference database of AISC section weights/ft |

## Railway deploy

See `DEPLOY_BID_PHASE_1.txt` for the full walkthrough.

Required env vars:
- `PORT` - set by Railway automatically
- `DATA_DIR` - `/app/data` (matches the mounted Railway volume)
- `FRONTEND_ORIGIN` - optional, comma-separated allowed CORS origins. Defaults to `*` if unset.

## Notes

- No auth in Phase 1. Will add when frontend ships.
- All computed totals come from `lib/calc.js`. Single source of truth for derived numbers. Frontend will import the same module.
- AISC database is seeded only if `aisc_sections` is empty. To re-seed, drop the table and restart.

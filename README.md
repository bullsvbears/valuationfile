# Valuation Dashboard

A stock valuation dashboard for a software coverage universe, ported from the
`Software Valuation File` workbook.

FactSet consensus is the baseline for every company. For a name you cover, your
own model supplies the years you forecast. A manual override sits on top of
both, for the cell you want to take a different view on.

## The three tiers

Every number on the dashboard comes from one of three tiers, and the dashboard
always shows which:

| Tier | Where it lives | Wins over |
| --- | --- | --- |
| `factset` | `data/factset-cache.json` | — |
| `model` | `data/models/<TICKER>.json` | FactSet |
| `override` | `data/overrides.json` | model, FactSet |

A tier only speaks for the cells it fills. A model that forecasts 2026-2028
leaves earlier years to FactSet, so a covered name gets vendor history and your
forward view without anything being copied between them. Clearing an override
falls back to whatever sits beneath it, so undoing an edit never requires
remembering what the vendor number was.

This is the structure the workbook already had. What it lacked was any way to
see it: a `FE_ESTIMATE` call, a typed-in actual and a link to an external model
workbook all rendered as a plain number in a cell, so which of the three you
were looking at was invisible once entered.

## Getting started

```bash
npm install
npm run dev          # API on :8787, UI on :5173
```

`npm run build && npm start` serves the built UI from the API process.

### Refreshing FactSet

The workbook reached FactSet through the `FDS()` Excel add-in, which exists
only inside Excel. The Formula API takes the same FQL strings over HTTP, so
`src/factset/fql.ts` is shared between them and only the transport differs.

```bash
npx tsx scripts/refresh-factset.ts --dry-run          # print the exact FQL
FACTSET_USERNAME_SERIAL=... FACTSET_API_KEY=... npm run refresh
```

A refresh rewrites only the FactSet tier. Overrides and models are separate
files and are never touched, so the consensus moves underneath your views
rather than over them.

The bundled `data/factset-cache.json` holds the cached FDS values read out of
the workbook. It is a starting point, not a live pull — run a refresh to make
it current.

## Hosting it

The dashboard carries licensed FactSet estimates and your own models, so it is
built to be reachable from anywhere but signed in to by one person. There is a
single account, configured by environment variable — no user store, because
there is only ever one user.

Set a password before exposing it. In production the server refuses to start
without `DASHBOARD_PASSWORD_HASH`, rather than quietly serving an open app.

```bash
npm run hash-password        # generates a strong password and prints both secrets
```

### Fly.io

```bash
fly launch --no-deploy --copy-config          # sets app name and region in fly.toml
fly volumes create valuation_data --size 1
fly secrets set DASHBOARD_PASSWORD_HASH='...' SESSION_SECRET='...'
fly deploy
```

`fly.toml` mounts a volume at `/data` and points `DATA_DIR` there. That volume
is the live data, not a cache: your overrides and models are written to it, and
a redeploy replaces the image while leaving it alone. On first boot an empty
volume is seeded once from the workbook import baked into the image, and never
overwritten after that.

To refresh FactSet on the deployed instance, set the credentials as secrets and
run the refresh there:

```bash
fly secrets set FACTSET_USERNAME_SERIAL='...' FACTSET_API_KEY='...'
fly ssh console -C "npx tsx scripts/refresh-factset.ts"
```

### What the auth does and does not do

- The password is stored only as an scrypt hash; `SESSION_SECRET` signs session
  cookies, and rotating it signs out every session at once.
- Sessions last 12 hours, are `HttpOnly` and `SameSite=Lax`, and are `Secure` in
  production. Cross-origin writes are refused even with a valid cookie.
- Sign-in attempts are rate limited per address, with a lockout after 8 failures.
- Sessions are a signed expiry rather than a server-side record, so a restart
  does not sign you out. That also means an individual session cannot be revoked
  without rotating the secret.
- One account, one password. If colleagues need access, this wants real
  per-user identity rather than a shared password.

### Before you put it on a public host

FactSet's licence generally covers you and other licensed users at your firm,
not anonymous visitors. A login satisfies that for a single-user deployment, but
if you are on a firm-wide agreement it is worth a word with compliance before
consensus estimates leave your machine. Running it behind a Cloudflare Tunnel
from hardware you control is the variant that keeps the data off a cloud host
entirely.


## Layout

```
src/lib/        resolver, metrics, peer-group roll-ups, persistence
src/factset/    FQL builders and the Formula API client
src/ui/         screener, company page, summaries, sign in
server/         REST API over the three tiers, auth, volume seeding
scripts/        workbook importer, fixture builder, FactSet refresh, password hashing
data/           the three tiers, one file per tier (models: one per ticker)
tests/          unit tests, an end-to-end server test, reconciliation against the workbook
Dockerfile      container image
fly.toml        Fly.io deployment with a persistent volume
```

## Reconciliation

`npm test` checks the port against the workbook itself. The fixture holds both
the inputs the Master Software sheet carried and the multiples Excel computed
from them, so the two halves are checked separately: the metrics engine
reproduces 3,000+ cached multiples from the sheet's own inputs, and the
importer reproduces 10,000+ line items from the three tiers.

Peer-group medians are checked the same way against the Sector Summary sheet.

### What the workbook disagrees with itself about

Reconciling surfaced places where the spreadsheet does not match its own
source. Each is pinned as an explicit list in `tests/reconciliation.test.ts`,
so it stays visible and a real regression cannot hide behind it.

- **Cached values that pre-date the last data refresh.** 108 cells across 9
  tickers (ALTR, CFLT, CWAN, CYBR, JAMF, ONTF, OS, SEMR, UDMY) where Master
  Software's cached VLOOKUP results disagree with the Data sheet feeding them.
  Separately, CWAN's P/E was cached before its price cell recalculated.
- **Summary ranges narrower than the group.** Security Software publishes a
  median of 6.37x, which is the 6th of its 13 sorted values — the median of an
  eleven-name group, not a thirteen-name one. `15%-20% Growth` has the same
  shape. The formula's range never grew when members were added.
- **A duplicated row.** PAYX appears twice on the Data sheet. `VLOOKUP` only
  ever reached the first, so the second was already dead weight. The importer
  skips repeats and reports them.

### Two conventions worth knowing

- **Multiples use current enterprise value.** A 2019 EV/Revenue column is
  today's EV against 2019 revenue, not what the company traded at in 2019. The
  workbook showed only forward years for this reason; the dashboard shows the
  full history and labels it.
- **`nm` versus blank.** Multiples outside 0.1x-200x and growth beyond ±1500%
  print as `nm`, matching the source sheet: a 400x EV/Revenue is a stale input,
  not a valuation signal. A blank means the input was missing. The workbook
  conflated the two for FCF yield, whose `IFERROR` printed `nm` on any failure.

## Importing the workbook again

```bash
python3 scripts/extract_workbook.py path/to/Software_Valuation_File.xlsx --out data
python3 scripts/build_reconciliation_fixture.py path/to/Software_Valuation_File.xlsx
```

The importer reads cell *formulas*, not just values, to recover which tier each
number belongs to — `FE_ESTIMATE` calls to FactSet, `[6]IS!$AY$6` links to the
model tier, and everything hand-typed to overrides, marked cell by cell as
imported so clearing your own overrides leaves the reported actuals alone.

Re-importing overwrites `data/`, including edits made in the app.

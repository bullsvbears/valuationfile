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

All editing happens on the **Companies Master** tab — a spreadsheet-shaped
grid, one metric at a time, every cell editable. Edits save as overrides, the
top tier, so every other tab (screener, company pages, sector and peer
summaries) follows the master without being editable itself. Each cell is
colored by its source, and clearing a cell falls back to the tier beneath.

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

Run these from the repository folder, the one containing `package.json`; `npm
run` has no idea what project you mean from anywhere else. Node 20 or newer.
Everything works the same on Windows, macOS and Linux — where a command differs
by shell, both forms are given.

`npm run build && npm start` serves the built UI from the API process.

### Refreshing FactSet

The workbook reached FactSet through the `FDS()` Excel add-in, which exists
only inside Excel. The Formula API takes the same FQL strings over HTTP, so
`src/factset/fql.ts` is shared between them and only the transport differs.

```bash
npx tsx scripts/refresh-factset.ts --dry-run          # print the exact FQL
FACTSET_USERNAME_SERIAL=... FACTSET_API_KEY=... npm run refresh
```

On Windows PowerShell, set the variables first — the inline `VAR=value command`
form is shell syntax that PowerShell does not have:

```powershell
$env:FACTSET_USERNAME_SERIAL = "..."
$env:FACTSET_API_KEY = "..."
npm run refresh
```

A refresh rewrites only the FactSet tier. Overrides and models are separate
files and are never touched, so the consensus moves underneath your views
rather than over them.

Once credentials are configured, refreshes run themselves: the first
dashboard request of each day pulls FactSet in the background and then
records the daily snapshot, in that order, so the Summary tab's day-over-day
diffs reflect real consensus revisions. The topbar's "Refresh FactSet"
button triggers the same pull on demand and shows the data's age.

The bundled `data/factset-cache.json` holds the cached FDS values read out of
the workbook. It is a starting point, not a live pull — run a refresh to make
it current.

### Year-end price baselines

Year-to-date returns divide by the prior year's final close. The server
looks for baselines in `data/year-end-closes.json` first (hand-supplied,
shipped with the image) and asks Polygon only for what that file leaves
open (when a key is configured).
To load a list from a spreadsheet (two columns: ticker, closing price):

```bash
python3 scripts/import_year_end_prices.py path/to/YE_Prices.xlsx 2025
```

A "Prior YE close" column in Master Input's Price & balance sheet view can
override any single name by hand.

### Backfilling history from old workbook copies

Old saved copies of the valuation file can become history snapshots, so
change-tracking reaches back before the app existed.

Per file:

```bash
python3 scripts/extract_workbook.py "2025-06-30 copy.xlsx" --out /tmp/asof
npx tsx scripts/backfill-snapshot.ts --data /tmp/asof --date 2025-06-30
```

That writes `data/history/2025-06-30.json` through the same resolver and
metrics engine the daily task uses. Add `--push https://your-app.fly.dev
--password <dashboard password>` to send it straight to a deployed instance
instead; only past dates are accepted — today's snapshot belongs to the
daily task.

### Free price updates without FactSet

Without FactSet credentials, the "Update prices" button and the daily task
pull end-of-day closes from Polygon.io. Sign up for a free key at
polygon.io and set it as a secret:

```powershell
fly secrets set POLYGON_API_KEY=your_key_here
```

One grouped-daily API call prices the whole universe — comfortably inside
the free tier's 5-requests-per-minute budget — with the most recent
completed session's closes (the free tier is end-of-day data). Prices,
market caps and multiples stay current; estimates stay at the workbook
import until FactSet is configured — neither Polygon nor Finnhub offers
consensus estimates on an accessible tier — and the topbar readout says
which source served the last update. Non-US listings and private names
(no USD listing on Polygon) and anything absent from the session file are
reported rather than silently left stale. `POLYGON_BASE_URL` overrides the
endpoint (used by the tests to point at a local stand-in).

## Backups

Two paths, both covering the whole data directory — models, overrides, the
FactSet cache, saved views, KPIs and the snapshot history:

- **Nightly git backup.** Set `BACKUP_GIT_REMOTE` (an HTTPS remote with a
  token, e.g. `https://x-access-token:<token>@github.com/you/repo.git`) and
  the daily task pushes the data files to a `data-backup` branch after each
  snapshot. Plain JSON in git restores the audit trail: every input change
  is a readable diff with a date. `BACKUP_GIT_BRANCH` overrides the branch.
  On Fly: `fly secrets set BACKUP_GIT_REMOTE='...'`. Use a fine-grained
  GitHub token scoped to just the backup repository, with contents
  read/write.
- **The Backup button** in the topbar downloads everything as one JSON
  bundle, for a copy on your machine right now.

## Hosting it

The dashboard carries licensed FactSet estimates and your own models, so it is
built to be reachable from anywhere but signed in to by one person. There is a
single account, configured by environment variable — no user store, because
there is only ever one user.

Set a password before exposing it. In production the server refuses to start
without `DASHBOARD_PASSWORD_HASH`, rather than quietly serving an open app.

```bash
npm run hash-password -- --out secrets.env
```

That writes a `KEY=value` file for `fly secrets import`, which is worth
preferring over pasting: the hash uses the conventional PHC layout, whose `$`
separators are shell metacharacters, and a mangled secret shows up as a password
that never works rather than as an error. The file is gitignored; delete it once
the secrets are set.

### Fly.io

```bash
fly apps create my-valuation-dashboard        # names are globally unique
```

Set `app` and `primary_region` in `fly.toml` to match (`fly platform regions`
lists the options). Then:

```bash
fly volumes create valuation_data --size 1 --yes
fly secrets import < secrets.env              # Get-Content secrets.env | fly secrets import
fly deploy --ha=false
```

`--ha=false` matters. Fly otherwise starts two machines for an HTTP service and
the second has no volume to mount, so the deploy fails. One machine is also what
this app wants: the JSON tiers have a single writer.

`fly.toml` mounts a volume at `/data` and points `DATA_DIR` there. That volume
is the live data, not a cache: your overrides and models are written to it, and
a redeploy replaces the image while leaving it alone. On first boot an empty
volume is seeded once from the workbook import baked into the image, and never
overwritten after that.

To refresh FactSet on the deployed instance, set the credentials as secrets and
run the refresh there:

```bash
fly secrets set FACTSET_USERNAME_SERIAL='...' FACTSET_API_KEY='...'
fly ssh console -C "node node_modules/tsx/dist/cli.mjs scripts/refresh-factset.ts"
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
src/ui/         screener, Companies Master editor, company page, summaries, sign in
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

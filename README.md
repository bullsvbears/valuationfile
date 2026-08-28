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

## Layout

```
src/lib/        resolver, metrics, peer-group roll-ups, persistence
src/factset/    FQL builders and the Formula API client
src/ui/         screener, company page, summaries
server/         REST API over the three tiers
scripts/        workbook importer, fixture builder, FactSet refresh
data/           the three tiers, one file per tier (models: one per ticker)
tests/          unit tests plus reconciliation against the workbook
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

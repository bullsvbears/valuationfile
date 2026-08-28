import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { buildDashboard } from '../src/lib/dashboard.js'
import { computeMetrics, isMeaningful, NM, type Multiple } from '../src/lib/metrics.js'
import { resolveCompany } from '../src/lib/resolve.js'
import type { CompanyMeta, FactSetCache, OverrideStore, OwnModel } from '../src/lib/types.js'
import type { Universe } from '../src/lib/store.js'

/**
 * Reconciliation against the source workbook.
 *
 * The fixture captures, per ticker, both the inputs the Master Software sheet
 * held and the multiples Excel computed from them. That splits the port into
 * two independently checkable halves:
 *
 *   1. the metrics engine, fed the sheet's own inputs, reproduces the sheet's
 *      own outputs; and
 *   2. the importer reproduces the sheet's inputs from the three data tiers.
 *
 * Keeping them apart matters because the workbook contains rows Excel never
 * finished recalculating. Those show up as a cached output that disagrees with
 * the cached inputs sitting beside it, and no correct port can reproduce them.
 */

const root = path.resolve(__dirname, '..')
const read = <T>(p: string): T => JSON.parse(readFileSync(path.join(root, p), 'utf8')) as T

interface ExpectedEntry {
  price: number | 'nm' | null
  marketCap: number | 'nm' | null
  enterpriseValue: number | 'nm' | null
  inputs: Partial<Record<'revenue' | 'grossProfit' | 'ebitda' | 'fcf' | 'eps', Record<string, number>>>
  metrics: Record<string, Record<string, number | 'nm'>>
}

const expected = read<Record<string, ExpectedEntry>>(
  'tests/fixtures/master-software-expected.json',
)

/** Relative tolerance: the fixture holds Excel's stored double-precision values. */
const TOLERANCE = 1e-6

/**
 * Metrics where the sheet wrapped the whole calculation in IFERROR and printed
 * "nm" on failure. There, "nm" means "could not be computed" and matches a null
 * here. Everywhere else "nm" came from an explicit band test and must match a
 * band rejection exactly.
 */
const NM_MEANS_MISSING: ReadonlySet<string> = new Set(['fcfYield'])

function agrees(actual: Multiple, want: number | 'nm', metric: string): boolean {
  if (want === NM) {
    return NM_MEANS_MISSING.has(metric) ? actual === null || actual === NM : actual === NM
  }
  if (!isMeaningful(actual)) return false
  if (Math.abs(want) < 1e-9) return Math.abs(actual) < 1e-9
  return Math.abs(actual - want) / Math.abs(want) < TOLERANCE
}

function meta(ticker: string): CompanyMeta {
  return {
    ticker,
    name: ticker,
    fiscalYearEnd: 12,
    coverage: null,
    covered: false,
    sectors: [],
    peerGroups: [],
  }
}

/**
 * Rebuild a company from the sheet's own cached numbers.
 *
 * Share count is backed out of cached market cap over cached price, and net
 * debt out of cached enterprise value less market cap, so the reconstruction
 * reproduces the sheet's EV bridge exactly rather than re-deriving it.
 */
function fromCachedInputs(ticker: string, entry: ExpectedEntry) {
  const price = typeof entry.price === 'number' ? entry.price : null
  const marketCap = typeof entry.marketCap === 'number' ? entry.marketCap : null
  const enterpriseValue = typeof entry.enterpriseValue === 'number' ? entry.enterpriseValue : null
  if (price === null || marketCap === null || enterpriseValue === null || price === 0) return null

  return computeMetrics(
    resolveCompany(meta(ticker), {
      factset: {
        price,
        balance: { shares: marketCap / price, cash: 0, debt: enterpriseValue - marketCap },
        series: entry.inputs,
      },
    }),
  )
}

/** Tickers whose cached outputs disagree with their own cached inputs. */
function findSelfInconsistent(): string[] {
  const stale = new Set<string>()
  for (const [ticker, entry] of Object.entries(expected)) {
    const metrics = fromCachedInputs(ticker, entry)
    if (!metrics) continue
    for (const [year, wanted] of Object.entries(entry.metrics)) {
      const actual = metrics.byYear[year]
      if (!actual) continue
      for (const [metric, want] of Object.entries(wanted)) {
        if (!agrees(actual[metric as keyof typeof actual] as Multiple, want, metric)) {
          stale.add(ticker)
        }
      }
    }
  }
  return [...stale].sort()
}

/**
 * The one row whose cached multiple its own neighbouring cached inputs do not
 * produce: CWAN's price cell was recalculated after its P/E was, so the two
 * disagree by the ~0.7% the price moved.
 */
const STALE_OUTPUTS = ['CWAN'] as const

/**
 * Rows where the Master Software sheet's cached VLOOKUP results pre-date the
 * last refresh of the Data sheet feeding them, so the sheet disagrees with its
 * own source. 108 cells across 9 tickers, out of more than ten thousand.
 *
 * Both lists are pinned rather than matched by pattern, so a genuine regression
 * cannot hide by quietly enlarging them.
 */
const STALE_INPUTS = [
  'ALTR', 'CFLT', 'CWAN', 'CYBR', 'JAMF', 'ONTF', 'OS', 'SEMR', 'UDMY',
] as const

describe('metrics engine vs the workbook', () => {
  it('finds only the known un-recalculated rows', () => {
    expect(findSelfInconsistent()).toEqual([...STALE_OUTPUTS])
  })

  it('reproduces every multiple the sheet computed, from the sheet own inputs', () => {
    const mismatches: string[] = []
    let compared = 0

    for (const [ticker, entry] of Object.entries(expected)) {
      if ((STALE_OUTPUTS as readonly string[]).includes(ticker)) continue
      const metrics = fromCachedInputs(ticker, entry)
      if (!metrics) continue

      for (const [year, wanted] of Object.entries(entry.metrics)) {
        const actual = metrics.byYear[year]
        if (!actual) continue
        for (const [metric, want] of Object.entries(wanted)) {
          compared += 1
          const got = actual[metric as keyof typeof actual] as Multiple
          if (!agrees(got, want, metric)) {
            mismatches.push(`${ticker} ${year} ${metric}: expected ${want}, got ${got}`)
          }
        }
      }
    }

    expect(compared).toBeGreaterThan(3000)
    expect(mismatches).toEqual([])
  })
})

describe('importer vs the workbook', () => {
  const universe = read<Universe>('data/universe.json')
  const factset = read<FactSetCache>('data/factset-cache.json')
  const overrides = read<OverrideStore>('data/overrides.json')

  const models: Record<string, OwnModel> = {}
  for (const company of universe.companies) {
    try {
      models[company.ticker] = JSON.parse(
        readFileSync(path.join(root, 'data', 'models', `${company.ticker}.json`), 'utf8'),
      ) as OwnModel
    } catch {
      // Most names have no owned model; that is the expected case.
    }
  }

  const dashboard = buildDashboard({ universe, factset, overrides, models })
  const byTicker = new Map(dashboard.companies.map((c) => [c.meta.ticker, c]))

  it('imports the full universe across all three tiers', () => {
    expect(universe.companies.length).toBe(335)
    expect(Object.keys(models).length).toBeGreaterThan(40)
    expect(Object.keys(factset.companies).length).toBeGreaterThan(200)
  })

  it('resolves back to the exact line items the sheet held', () => {
    const mismatches: string[] = []
    const staleTickers = new Set<string>()
    let compared = 0

    for (const [ticker, entry] of Object.entries(expected)) {
      const company = byTicker.get(ticker)
      if (!company) continue
      const knownStale = (STALE_INPUTS as readonly string[]).includes(ticker)
      for (const [metric, years] of Object.entries(entry.inputs)) {
        for (const [year, want] of Object.entries(years ?? {})) {
          // Excel's VLOOKUP returns 0 for a blank source cell, so a cached 0
          // is indistinguishable from missing data and carries no information.
          if (want === 0) continue
          const cell = company.resolved.series[metric as 'revenue'][year]
          compared += 1
          const got = cell?.value ?? null
          const differs =
            got === null || Math.abs(got - want) / Math.max(Math.abs(want), 1e-9) > TOLERANCE
          if (!differs) continue

          if (knownStale) staleTickers.add(ticker)
          else mismatches.push(`${ticker} ${year} ${metric}: expected ${want}, got ${got}`)
        }
      }
    }

    expect(compared).toBeGreaterThan(10000)
    expect(mismatches).toEqual([])
    // Every pinned ticker must still be stale, so the list cannot rot into a
    // blanket exemption once the underlying data is refreshed.
    expect([...staleTickers].sort()).toEqual([...STALE_INPUTS])
  })

  it('assigns every covered company forward years from its own model', () => {
    const covered = universe.companies.filter((c) => c.covered && models[c.ticker])
    expect(covered.length).toBeGreaterThan(40)

    for (const company of covered) {
      const view = byTicker.get(company.ticker)
      if (!view) continue
      const modelYears = Object.keys(models[company.ticker]?.series?.revenue ?? {})
      for (const year of modelYears) {
        expect(view.resolved.series.revenue[year]?.tier).toBe('model')
      }
    }
  })
})

describe('peer-group roll-ups vs the Sector Summary sheet', () => {
  const universe = read<Universe>('data/universe.json')
  const summaryExpected = read<Record<string, { n: number | null; evRevenueMedian: number }>>(
    'tests/fixtures/sector-summary-expected.json',
  )
  const groups: Record<string, string[]> = { ...universe.sectors, ...universe.peerGroups }

  /**
   * Groups whose published median covers fewer names than the group itself
   * holds, because the summary formula's range was never extended when members
   * were added. Security Software publishes the 6th of 13 sorted values, which
   * is the median of an eleven-name group, not a thirteen-name one.
   */
  const RANGE_LAGS_MEMBERSHIP = ['15%-20% Growth', 'Security Software'] as const

  function medianEvRevenue(members: string[]): number | null {
    const values = members
      .map((t) => expected[t]?.metrics['2027']?.evRevenue)
      .filter((v): v is number => typeof v === 'number')
      .sort((a, b) => a - b)
    if (!values.length) return null
    const mid = Math.floor(values.length / 2)
    return values.length % 2 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2
  }

  it('reproduces the published median for every group whose range is current', () => {
    const mismatches: string[] = []
    const lagging: string[] = []
    let compared = 0

    for (const [group, published] of Object.entries(summaryExpected)) {
      const members = groups[group]
      if (!members) continue
      const ours = medianEvRevenue(members)
      if (ours === null) continue

      compared += 1
      const differs =
        Math.abs(ours - published.evRevenueMedian) / Math.abs(published.evRevenueMedian) > TOLERANCE
      if (!differs) continue

      if ((RANGE_LAGS_MEMBERSHIP as readonly string[]).includes(group)) lagging.push(group)
      else {
        mismatches.push(
          `${group}: sheet ${published.evRevenueMedian.toFixed(3)}, ours ${ours.toFixed(3)}`,
        )
      }
    }

    expect(compared).toBeGreaterThan(25)
    expect(mismatches).toEqual([])
    expect(lagging.sort()).toEqual([...RANGE_LAGS_MEMBERSHIP])
  })
})

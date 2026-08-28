import { describe, expect, it } from 'vitest'
import { mean, median, summariseGroup, summariseGroups } from '../src/lib/aggregate.js'
import { computeMetrics } from '../src/lib/metrics.js'
import { resolveCompany } from '../src/lib/resolve.js'
import type { CompanyMeta } from '../src/lib/types.js'

function company(ticker: string, revenue: number, price = 10) {
  const meta: CompanyMeta = {
    ticker,
    name: ticker,
    fiscalYearEnd: 12,
    coverage: null,
    covered: false,
    sectors: [],
    peerGroups: [],
  }
  return computeMetrics(
    resolveCompany(meta, {
      factset: {
        price,
        balance: { shares: 100, cash: 0, debt: 0 },
        series: { revenue: { '2026': revenue }, fcf: { '2026': revenue * 0.1 } },
      },
    }),
  )
}

describe('summary statistics', () => {
  it('returns null for an empty sample rather than NaN', () => {
    expect(mean([])).toBeNull()
    expect(median([])).toBeNull()
  })

  it('takes the midpoint of an even-sized sample', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([3, 1, 2])).toBe(2)
  })
})

describe('peer group roll-ups', () => {
  it('computes mean and median EV/Revenue across a group', () => {
    // 1000 market cap against revenue of 100/200/400 gives 10x/5x/2.5x.
    const summary = summariseGroup('Test', [
      company('A', 100), company('B', 200), company('C', 400),
    ], '2026')
    expect(summary.stats.evRevenue?.median).toBeCloseTo(5)
    expect(summary.stats.evRevenue?.mean).toBeCloseTo((10 + 5 + 2.5) / 3)
    expect(summary.stats.evRevenue?.n).toBe(3)
  })

  it('excludes not-meaningful members without dropping them from the roster', () => {
    // 0.5 revenue against a 1000 market cap is 2000x, outside the band.
    const summary = summariseGroup('Test', [
      company('A', 100), company('B', 200), company('NM', 0.5),
    ], '2026')
    expect(summary.members).toHaveLength(3)
    expect(summary.stats.evRevenue?.n).toBe(2)
    expect(summary.stats.evRevenue?.median).toBeCloseTo(7.5)
  })

  it('summarises several named groups against one metrics table', () => {
    const metrics = { A: company('A', 100), B: company('B', 200), C: company('C', 400) }
    const summaries = summariseGroups({ Big: ['A', 'B'], All: ['A', 'B', 'C'] }, metrics, '2026')
    expect(summaries.map((s) => s.group)).toEqual(['Big', 'All'])
    expect(summaries[0]!.stats.evRevenue?.n).toBe(2)
    expect(summaries[1]!.stats.evRevenue?.n).toBe(3)
  })

  it('ignores tickers with no metrics rather than failing the group', () => {
    const summaries = summariseGroups({ G: ['A', 'MISSING'] }, { A: company('A', 100) }, '2026')
    expect(summaries[0]!.members).toEqual(['A'])
  })
})

import { describe, expect, it } from 'vitest'
import { computeMetrics, NM } from '../src/lib/metrics.js'
import { resolveCompany } from '../src/lib/resolve.js'
import type { CompanyMeta } from '../src/lib/types.js'

const meta: CompanyMeta = {
  ticker: 'TEST',
  name: 'Test Co',
  fiscalYearEnd: 12,
  covered: false,
  coverage: null,
  sectors: [],
  peerGroups: [],
}

function build(facts: Parameters<typeof resolveCompany>[1]['factset']) {
  return computeMetrics(resolveCompany(meta, { factset: facts }))
}

describe('valuation metrics', () => {
  const base = {
    price: 10,
    balance: { shares: 100, cash: 200, debt: 100 },
    series: {
      revenue: { '2025': 500, '2026': 600 },
      grossProfit: { '2026': 480 },
      ebitda: { '2026': 120 },
      fcf: { '2026': 60 },
      eps: { '2026': 0.5 },
    },
  }

  it('bridges market cap to enterprise value as cap less cash plus debt', () => {
    const m = build(base)
    expect(m.marketCap).toBe(1000)
    expect(m.enterpriseValue).toBe(900)
  })

  it('computes the core multiples off enterprise value', () => {
    const y = build(base).byYear['2026']!
    expect(y.evRevenue).toBeCloseTo(1.5)
    expect(y.evGrossProfit).toBeCloseTo(1.875)
    expect(y.evEbitda).toBeCloseTo(7.5)
    expect(y.evFcf).toBeCloseTo(15)
    expect(y.pe).toBeCloseTo(20)
  })

  it('computes FCF yield against market cap, not enterprise value', () => {
    expect(build(base).byYear['2026']!.fcfYield).toBeCloseTo(0.06)
  })

  it('derives margins, growth and Rule of 40', () => {
    const y = build(base).byYear['2026']!
    expect(y.revenueGrowth).toBeCloseTo(0.2)
    expect(y.grossMargin).toBeCloseTo(0.8)
    expect(y.fcfMargin).toBeCloseTo(0.1)
    expect(y.ruleOf40).toBeCloseTo(0.3) // 20% growth + 10% FCF margin
  })

  it('scales EV/Revenue by growth and by Rule of 40', () => {
    const y = build(base).byYear['2026']!
    expect(y.evRevenueGrowth).toBeCloseTo(1.5 / 0.2)
    expect(y.evRevenueR40).toBeCloseTo(1.5 / 0.3)
  })

  it('marks multiples outside the 0.1x-200x band as not meaningful', () => {
    const tiny = build({ ...base, series: { ...base.series, ebitda: { '2026': 0.5 } } })
    expect(tiny.byYear['2026']!.evEbitda).toBe(NM)

    const huge = build({ ...base, series: { ...base.series, revenue: { '2026': 100000 } } })
    expect(huge.byYear['2026']!.evRevenue).toBe(NM)
  })

  it('keeps the sign meaningful when a company crosses from loss to profit', () => {
    // -50 to +50 is a 200% improvement, not a 200% decline: the source sheet
    // divided by the absolute value of the prior year for exactly this case.
    const m = build({
      ...base,
      series: { ...base.series, ebitda: { '2025': -50, '2026': 50 } },
    })
    expect(m.byYear['2026']!.ebitdaGrowth).toBeCloseTo(2)
  })

  it('suppresses growth off a near-zero base as not meaningful', () => {
    const m = build({
      ...base,
      series: { ...base.series, fcf: { '2025': 0.1, '2026': 60 } },
    })
    expect(m.byYear['2026']!.fcfGrowth).toBe(NM)
  })

  it('returns nulls rather than throwing when inputs are missing', () => {
    const m = build({ series: { revenue: { '2026': 500 } } })
    expect(m.enterpriseValue).toBeNull()
    expect(m.byYear['2026']!.evRevenue).toBeNull()
    expect(m.byYear['2026']!.pe).toBeNull()
  })

  it('does not divide by a zero denominator', () => {
    const m = build({ ...base, series: { ...base.series, eps: { '2026': 0 } } })
    expect(m.byYear['2026']!.pe).toBeNull()
  })
})

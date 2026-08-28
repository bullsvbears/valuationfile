import { describe, expect, it } from 'vitest'
import { resolveCompany, tierBreakdown } from '../src/lib/resolve.js'
import type { CompanyMeta } from '../src/lib/types.js'

const meta: CompanyMeta = {
  ticker: 'TEST',
  name: 'Test Co',
  fiscalYearEnd: 12,
  coverage: 'Covered',
  covered: true,
  sectors: [],
  peerGroups: [],
}

describe('tier resolution', () => {
  it('falls back to FactSet when no other tier has an opinion', () => {
    const resolved = resolveCompany(meta, {
      factset: { series: { revenue: { '2026': 100 } } },
    })
    expect(resolved.series.revenue['2026']).toMatchObject({ value: 100, tier: 'factset' })
  })

  it('prefers the analyst model over FactSet', () => {
    const resolved = resolveCompany(meta, {
      factset: { series: { revenue: { '2026': 100 } } },
      model: { series: { revenue: { '2026': 115 } } },
    })
    expect(resolved.series.revenue['2026']).toMatchObject({
      value: 115,
      tier: 'model',
      shadowed: ['factset'],
    })
  })

  it('lets a manual override win over both other tiers', () => {
    const resolved = resolveCompany(meta, {
      factset: { series: { revenue: { '2026': 100 } } },
      model: { series: { revenue: { '2026': 115 } } },
      override: { series: { revenue: { '2026': 120 } } },
    })
    expect(resolved.series.revenue['2026']).toMatchObject({
      value: 120,
      tier: 'override',
      shadowed: ['factset', 'model'],
    })
  })

  it('applies a model only to the years it forecasts', () => {
    // A covered name typically has FactSet history and an owned forward view;
    // the years the model is silent on must keep falling through to FactSet.
    const resolved = resolveCompany(meta, {
      factset: { series: { revenue: { '2024': 80, '2025': 90, '2026': 100 } } },
      model: { series: { revenue: { '2026': 115 } } },
    })
    expect(resolved.series.revenue['2024']?.tier).toBe('factset')
    expect(resolved.series.revenue['2025']?.tier).toBe('factset')
    expect(resolved.series.revenue['2026']?.tier).toBe('model')
  })

  it('treats a null in a higher tier as no opinion, not as a zero', () => {
    const resolved = resolveCompany(meta, {
      factset: { series: { revenue: { '2026': 100 } } },
      override: { series: { revenue: { '2026': null } } },
    })
    expect(resolved.series.revenue['2026']).toMatchObject({ value: 100, tier: 'factset' })
  })

  it('resolves balance sheet items and price through the same precedence', () => {
    const resolved = resolveCompany(meta, {
      factset: { balance: { shares: 100, cash: 50, debt: 10 }, price: 20 },
      override: { balance: { shares: 105 }, price: 22 },
    })
    expect(resolved.balance.shares).toMatchObject({ value: 105, tier: 'override' })
    expect(resolved.balance.cash).toMatchObject({ value: 50, tier: 'factset' })
    expect(resolved.price).toMatchObject({ value: 22, tier: 'override' })
  })

  it('counts live cells per tier for the provenance summary', () => {
    const resolved = resolveCompany(meta, {
      factset: { series: { revenue: { '2025': 90, '2026': 100 } }, balance: { cash: 5 } },
      model: { series: { revenue: { '2026': 115 } } },
    })
    expect(tierBreakdown(resolved)).toEqual({ factset: 2, model: 1, override: 0 })
  })
})

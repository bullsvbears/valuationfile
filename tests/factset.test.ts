import { describe, expect, it } from 'vitest'
import {
  companyFormulas,
  estimateFormula,
  periodicityFor,
} from '../src/factset/fql.js'
import { credentialsFromEnv, parseCompanyRow } from '../src/factset/client.js'

describe('FactSet query building', () => {
  it('pulls December, January and November filers on the annual calendar', () => {
    for (const month of [11, 12, 1]) expect(periodicityFor(month)).toBe('ANN')
  })

  it('calendarises every other fiscal year end so peers stay comparable', () => {
    for (const month of [2, 4, 7, 10]) expect(periodicityFor(month)).toBe('CALA')
    expect(periodicityFor(null)).toBe('CALA')
  })

  it('reproduces the formula string the workbook sent for a December filer', () => {
    expect(estimateFormula('revenue', 2027, 12)).toBe(
      "FE_ESTIMATE(SALES,MEAN,ANN,2027,NOW,,,'CURRENCY=USD,FIXEDRATE=NO')",
    )
  })

  it('reproduces the calendarised form for an off-cycle filer', () => {
    expect(estimateFormula('ebitda', 2026, 7)).toBe(
      "FE_ESTIMATE(EBITDA,MEAN,CALA,2026,NOW,,,'CURRENCY=USD,FIXEDRATE=NO')",
    )
  })

  it('always pulls EPS calendarised, whatever the fiscal year end', () => {
    expect(estimateFormula('eps', 2026, 12)).toContain('CALA')
  })

  it('requests every metric and year for a company', () => {
    const formulas = companyFormulas(12, [2025, 2026])
    expect(formulas['revenue:2025']).toContain('FE_ESTIMATE(SALES')
    expect(formulas['grossProfit:2026']).toContain('INC_GROSS')
    expect(formulas.price).toContain('P_PRICE')
    expect(formulas.cash).toContain('FF_CASH_ST')
    expect(formulas.debt).toContain('FF_DEBT')
  })
})

describe('FactSet response parsing', () => {
  it('splits metric:year fields into annual series', () => {
    const facts = parseCompanyRow({
      requestId: 'CRM',
      'revenue:2026': 46258.9,
      'revenue:2027': 49947.7,
      'fcf:2026': 15000,
      price: 250,
      shares: 821,
      cash: 11403,
      debt: 39288,
    })
    expect(facts.series.revenue).toEqual({ '2026': 46258.9, '2027': 49947.7 })
    expect(facts.series.fcf).toEqual({ '2026': 15000 })
    expect(facts.balance).toEqual({ shares: 821, cash: 11403, debt: 39288 })
    expect(facts.price).toBe(250)
  })

  it('falls back to the reported diluted share base when the current count is missing', () => {
    const facts = parseCompanyRow({ requestId: 'X', shares: null, sharesFallback: 100 })
    expect(facts.balance?.shares).toBe(100)
  })

  it('treats non-numeric vendor responses as missing rather than zero', () => {
    const facts = parseCompanyRow({ requestId: 'X', 'revenue:2026': '#NA', cash: 'n/a' })
    expect(facts.series.revenue?.['2026']).toBeNull()
    expect(facts.balance?.cash).toBeNull()
  })

  it('reports missing credentials rather than issuing an unauthenticated call', () => {
    expect(credentialsFromEnv({})).toBeNull()
    expect(credentialsFromEnv({ FACTSET_USERNAME_SERIAL: 'a' })).toBeNull()
    expect(credentialsFromEnv({ FACTSET_USERNAME_SERIAL: 'a', FACTSET_API_KEY: 'b' }))
      .toMatchObject({ usernameSerial: 'a', apiKey: 'b' })
  })
})

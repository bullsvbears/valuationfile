import type { MetricKey, ResolvedCompany } from './types.js'

/**
 * Valuation math, ported from the `Master Software` sheet of the original
 * workbook. The guard rails below are deliberate copies of that sheet's
 * behaviour rather than new inventions, so numbers reconcile against the file
 * the desk already trusts.
 */

/** A multiple the sheet would print as "nm" (not meaningful) rather than a number. */
export const NM = 'nm' as const
export type Multiple = number | typeof NM | null

/**
 * Multiples outside this band were shown as "nm" in the source sheet.
 * A sub-0.1x or 200x+ EV/Revenue is nearly always a stale or mis-scaled input,
 * not a real valuation signal.
 */
const MULTIPLE_MIN = 0.1
const MULTIPLE_MAX = 200

/** Growth rates beyond +/-1500% were shown as "nm" (tiny or sign-flipping bases). */
const GROWTH_LIMIT = 15

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** A ratio, suppressed to "nm" when it falls outside the meaningful band. */
function guardedRatio(numerator: number | null, denominator: number | null): Multiple {
  if (numerator === null || denominator === null || denominator === 0) return null
  const r = numerator / denominator
  if (!Number.isFinite(r)) return null
  return r < MULTIPLE_MIN || r > MULTIPLE_MAX ? NM : r
}

/** A plain ratio with no band check, used where the sheet did not guard. */
function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null
  const r = numerator / denominator
  return Number.isFinite(r) ? r : null
}

/**
 * Period-over-period growth off an absolute base.
 *
 * Dividing by `Math.abs(prior)` keeps the sign meaningful when a company swings
 * out of a loss: EBITDA going from -50 to +50 reads as +200%, not -200%.
 */
function growth(current: number | null, prior: number | null): Multiple {
  if (current === null || prior === null || prior === 0) return null
  const g = (current - prior) / Math.abs(prior)
  if (!Number.isFinite(g)) return null
  return Math.abs(g) > GROWTH_LIMIT ? NM : g
}

export function isMeaningful(v: Multiple): v is number {
  return typeof v === 'number'
}

export interface YearMetrics {
  year: string
  revenue: number | null
  grossProfit: number | null
  ebitda: number | null
  fcf: number | null
  eps: number | null

  revenueGrowth: Multiple
  ebitdaGrowth: Multiple
  fcfGrowth: Multiple
  epsGrowth: Multiple

  grossMargin: number | null
  ebitdaMargin: number | null
  fcfMargin: number | null
  /** Revenue growth + FCF margin, the desk's Rule of 40 definition. */
  ruleOf40: number | null

  evRevenue: Multiple
  evGrossProfit: Multiple
  evEbitda: Multiple
  evFcf: Multiple
  /** EV/Revenue per point of growth: cheapness adjusted for growth. */
  evRevenueGrowth: Multiple
  /** EV/Revenue per point of Rule of 40. */
  evRevenueR40: Multiple
  fcfYield: number | null
  pe: Multiple
}

export interface CompanyMetrics {
  ticker: string
  price: number | null
  marketCap: number | null
  enterpriseValue: number | null
  years: string[]
  byYear: Record<string, YearMetrics>
}

function seriesValue(company: ResolvedCompany, metric: MetricKey, year: string): number | null {
  return num(company.series[metric][year]?.value)
}

/** Union of years present across all annual series, sorted ascending. */
export function companyYears(company: ResolvedCompany): string[] {
  const years = new Set<string>()
  for (const metric of Object.keys(company.series) as MetricKey[]) {
    for (const y of Object.keys(company.series[metric])) years.add(y)
  }
  return [...years].sort()
}

/**
 * Compute every dashboard metric for one company.
 *
 * Enterprise value follows the source sheet: market cap less cash plus debt,
 * with market cap struck off diluted shares rather than basic.
 */
export function computeMetrics(company: ResolvedCompany): CompanyMetrics {
  const price = num(company.price.value)
  const shares = num(company.balance.shares.value)
  const cash = num(company.balance.cash.value)
  const debt = num(company.balance.debt.value)

  const marketCap = price !== null && shares !== null ? price * shares : null
  const enterpriseValue =
    marketCap !== null && cash !== null && debt !== null ? marketCap - cash + debt : null

  const years = companyYears(company)
  const byYear: Record<string, YearMetrics> = {}

  years.forEach((year) => {
    // The prior calendar year specifically, not merely the previous year that
    // happens to be present: a gap in the data must break the growth chain
    // rather than quietly compare 2025 against 2023.
    const prevYear = String(Number(year) - 1)

    const revenue = seriesValue(company, 'revenue', year)
    const grossProfit = seriesValue(company, 'grossProfit', year)
    const ebitda = seriesValue(company, 'ebitda', year)
    const fcf = seriesValue(company, 'fcf', year)
    const eps = seriesValue(company, 'eps', year)

    const prior = (metric: MetricKey) =>
      prevYear ? seriesValue(company, metric, prevYear) : null

    const revenueGrowth = growth(revenue, prior('revenue'))
    const fcfMargin = ratio(fcf, revenue)
    const ruleOf40 =
      isMeaningful(revenueGrowth) && fcfMargin !== null ? revenueGrowth + fcfMargin : null

    const evRevenue = guardedRatio(enterpriseValue, revenue)

    byYear[year] = {
      year,
      revenue,
      grossProfit,
      ebitda,
      fcf,
      eps,

      revenueGrowth,
      ebitdaGrowth: growth(ebitda, prior('ebitda')),
      fcfGrowth: growth(fcf, prior('fcf')),
      epsGrowth: growth(eps, prior('eps')),

      grossMargin: ratio(grossProfit, revenue),
      ebitdaMargin: ratio(ebitda, revenue),
      fcfMargin,
      ruleOf40,

      evRevenue,
      // EV/GP and EV/Rev-derived ratios were left unguarded in the source sheet.
      evGrossProfit: ratio(enterpriseValue, grossProfit),
      evEbitda: guardedRatio(enterpriseValue, ebitda),
      evFcf: guardedRatio(enterpriseValue, fcf),
      evRevenueGrowth: isMeaningful(evRevenue) && isMeaningful(revenueGrowth)
        ? ratio(evRevenue, revenueGrowth)
        : null,
      evRevenueR40: isMeaningful(evRevenue) ? ratio(evRevenue, ruleOf40) : null,
      fcfYield: ratio(fcf, marketCap),
      pe: guardedRatio(price, eps),
    }
  })

  return {
    ticker: company.meta.ticker,
    price,
    marketCap,
    enterpriseValue,
    years,
    byYear,
  }
}

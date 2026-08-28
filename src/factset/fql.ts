/**
 * FactSet Query Language builders.
 *
 * These reproduce, string for string, the `FDS()` calls the Excel workbook
 * relied on. Keeping them identical means the web dashboard and the legacy
 * spreadsheet ask FactSet the same question and get the same answer, which is
 * what makes the two reconcilable during a migration.
 */

/** Estimate items, matching the `FE_ESTIMATE` calls in the workbook's Data sheet. */
export const ESTIMATE_ITEMS = {
  revenue: 'SALES',
  grossProfit: 'INC_GROSS',
  ebitda: 'EBITDA',
  fcf: 'FCF',
  eps: 'EPS',
} as const

export type EstimateMetric = keyof typeof ESTIMATE_ITEMS

/**
 * Fiscal year ends that FactSet's annual (`ANN`) periodicity already aligns to
 * the calendar year closely enough for the desk's purposes. Everything else is
 * pulled calendarised (`CALA`) so a July or October year end is restated onto
 * calendar years before it is compared with a December filer.
 */
const CALENDAR_ALIGNED_MONTHS: ReadonlySet<number> = new Set([11, 12, 1])

export function periodicityFor(fiscalYearEnd: number | null): 'ANN' | 'CALA' {
  if (fiscalYearEnd === null) return 'CALA'
  return CALENDAR_ALIGNED_MONTHS.has(fiscalYearEnd) ? 'ANN' : 'CALA'
}

const CURRENCY_FLAGS = "'CURRENCY=USD,FIXEDRATE=NO'"

/**
 * Consensus mean estimate for one metric and calendar year.
 *
 * EPS is always taken calendarised: the workbook pulled it that way for every
 * company regardless of fiscal year end, since per-share figures are compared
 * across the group far more often than they are read on a filer's own calendar.
 */
export function estimateFormula(
  metric: EstimateMetric,
  year: number,
  fiscalYearEnd: number | null,
): string {
  const item = ESTIMATE_ITEMS[metric]
  const periodicity = metric === 'eps' ? 'CALA' : periodicityFor(fiscalYearEnd)
  return `FE_ESTIMATE(${item},MEAN,${periodicity},${year},NOW,,,${CURRENCY_FLAGS})`
}

/** Month (1-12) in which the company's most recent annual period ended. */
export function fiscalYearEndFormula(): string {
  return 'MONTH(FF_FISCAL_DATE(ANN_R,0,,,,"DATE"))'
}

/**
 * Diluted share count in millions.
 *
 * The workbook preferred FactSet's current total share count and fell back to
 * the last reported diluted EPS share base, so a recent buyback or raise is
 * reflected before the next filing lands.
 */
export const SHARES_PRIMARY = "FCS_SHARES_INTERIM(TOT,SHS,0,,,USD,M,'CURRENT')"
export const SHARES_FALLBACK = 'FF_COM_SHS_OUT_EPS_DIL(QTR,0,,,RF)'

/** Most recent reported cash and total debt, used for the EV bridge. */
export const CASH_FORMULA = 'FF_CASH_ST(QTR,0,,,RF,USD)'
export const DEBT_FORMULA = 'FF_DEBT(QTR,0,,,RF,USD)'

/** Latest price and returns, as pulled by the Master Software sheet. */
export const PRICE_FORMULA = 'P_PRICE(now,,,USD)'
export const YTD_RETURN_FORMULA = 'P_PRICE_RETURNS(0,0CY,NOW)'
export const COMPANY_NAME_FORMULA = 'PROPER(FF_CO_NAME)'

export function calendarYearReturnFormula(year: number): string {
  return `P_PRICE_RETURNS(0,01/01/${year},12/31/${year},RANGE)`
}

/** Every formula needed to refresh one company, keyed by field name. */
export function companyFormulas(
  fiscalYearEnd: number | null,
  years: number[],
): Record<string, string> {
  const formulas: Record<string, string> = {
    name: COMPANY_NAME_FORMULA,
    fiscalYearEnd: fiscalYearEndFormula(),
    price: PRICE_FORMULA,
    ytdReturn: YTD_RETURN_FORMULA,
    shares: SHARES_PRIMARY,
    sharesFallback: SHARES_FALLBACK,
    cash: CASH_FORMULA,
    debt: DEBT_FORMULA,
  }
  for (const metric of Object.keys(ESTIMATE_ITEMS) as EstimateMetric[]) {
    for (const year of years) {
      formulas[`${metric}:${year}`] = estimateFormula(metric, year, fiscalYearEnd)
    }
  }
  return formulas
}

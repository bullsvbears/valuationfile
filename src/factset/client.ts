import type { CompanyFacts, FactSetCache, MetricKey } from '../lib/types.js'
import { companyFormulas, type EstimateMetric } from './fql.js'

/**
 * Client for FactSet's Formula API.
 *
 * The Excel workbook reached FactSet through the `FDS()` add-in, which only
 * exists inside Excel. The Formula API accepts the same FQL strings over HTTP,
 * so `fql.ts` is shared verbatim between the two and only the transport differs.
 *
 * Credentials come from the environment and are never written to disk with the
 * cache:
 *   FACTSET_USERNAME_SERIAL   e.g. "user-serial"
 *   FACTSET_API_KEY           API key generated in the FactSet developer portal
 */

const DEFAULT_ENDPOINT = 'https://api.factset.com/formula-api/v1/cross-sectional'

export interface FactSetCredentials {
  usernameSerial: string
  apiKey: string
  endpoint?: string
}

export function credentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): FactSetCredentials | null {
  const usernameSerial = env.FACTSET_USERNAME_SERIAL
  const apiKey = env.FACTSET_API_KEY
  if (!usernameSerial || !apiKey) return null
  return { usernameSerial, apiKey, endpoint: env.FACTSET_ENDPOINT ?? DEFAULT_ENDPOINT }
}

export interface RefreshTarget {
  ticker: string
  fiscalYearEnd: number | null
}

export interface RefreshOptions {
  years: number[]
  /** Tickers per request. FactSet rejects very large batches. */
  batchSize?: number
  fetchImpl?: typeof fetch
}

interface FormulaResponseRow {
  requestId?: string
  [field: string]: unknown
}

function authHeader(creds: FactSetCredentials): string {
  const token = Buffer.from(`${creds.usernameSerial}:${creds.apiKey}`).toString('base64')
  return `Basic ${token}`
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

/**
 * Turn one company's flat `field -> value` response into structured facts.
 *
 * Returns are reported by FactSet in percentage points, so they are divided by
 * 100 here to match the fractions the rest of the app works in.
 */
export function parseCompanyRow(row: FormulaResponseRow): CompanyFacts {
  const series: Partial<Record<MetricKey, Record<string, number | null>>> = {}

  for (const [field, raw] of Object.entries(row)) {
    const [metric, year] = field.split(':')
    if (!year || !metric) continue
    const key = metric as EstimateMetric
    series[key] ??= {}
    series[key]![year] = toNumber(raw)
  }

  const shares = toNumber(row.shares) ?? toNumber(row.sharesFallback)

  return {
    series,
    balance: { shares, cash: toNumber(row.cash), debt: toNumber(row.debt) },
    price: toNumber(row.price),
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Fetch fresh FactSet data for a set of tickers.
 *
 * Companies are grouped by fiscal year end because the estimate periodicity
 * (`ANN` vs `CALA`) is baked into the formula string, so every ticker in one
 * request must share the same calendarisation.
 */
export async function fetchFactSet(
  creds: FactSetCredentials,
  targets: RefreshTarget[],
  options: RefreshOptions,
): Promise<FactSetCache> {
  const doFetch = options.fetchImpl ?? fetch
  const batchSize = options.batchSize ?? 50
  const companies: Record<string, CompanyFacts> = {}

  const byFiscalEnd = new Map<number | null, RefreshTarget[]>()
  for (const t of targets) {
    const list = byFiscalEnd.get(t.fiscalYearEnd) ?? []
    list.push(t)
    byFiscalEnd.set(t.fiscalYearEnd, list)
  }

  for (const [fiscalYearEnd, group] of byFiscalEnd) {
    const formulas = companyFormulas(fiscalYearEnd, options.years)
    const fields = Object.entries(formulas)

    for (const batch of chunk(group, batchSize)) {
      const url = new URL(creds.endpoint ?? DEFAULT_ENDPOINT)
      url.searchParams.set('ids', batch.map((t) => t.ticker).join(','))
      for (const [alias, formula] of fields) {
        url.searchParams.append('formulas', `${formula} as ${alias}`)
      }

      const res = await doFetch(url.toString(), {
        headers: { Authorization: authHeader(creds), Accept: 'application/json' },
      })
      if (!res.ok) {
        throw new Error(
          `FactSet request failed (${res.status} ${res.statusText}): ${await res.text()}`,
        )
      }

      const body = (await res.json()) as { data?: FormulaResponseRow[] }
      for (const row of body.data ?? []) {
        const ticker = String(row.requestId ?? '')
        if (ticker) companies[ticker] = parseCompanyRow(row)
      }
    }
  }

  return {
    asOf: new Date().toISOString(),
    source: 'FactSet Formula API',
    companies,
  }
}

import { isMeaningful, type CompanyMetrics, type Multiple, type YearMetrics } from './metrics.js'

/**
 * Peer-group roll-ups, matching the `Sector Summary` sheet: a mean and a median
 * per group, computed only over companies with a meaningful value so a single
 * "nm" name cannot poison a sector median.
 */

/** Metrics that can be aggregated across a peer group. */
export type AggregatableMetric = {
  [K in keyof YearMetrics]: YearMetrics[K] extends Multiple | number | null ? K : never
}[keyof YearMetrics]

const EXCLUDED: ReadonlySet<string> = new Set(['year'])

function usable(v: unknown): v is number {
  if (typeof v !== 'number') return false
  return Number.isFinite(v)
}

export function mean(values: number[]): number | null {
  if (!values.length) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

export function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] as number
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

export interface GroupStat {
  mean: number | null
  median: number | null
  /** How many group members contributed a meaningful value. */
  n: number
}

export interface GroupSummary {
  group: string
  year: string
  /** Members of the group, whether or not each had usable data. */
  members: string[]
  stats: Partial<Record<AggregatableMetric, GroupStat>>
}

/** Pull the comparable values for one metric across a group, dropping "nm"/null. */
function collect(
  metrics: CompanyMetrics[],
  year: string,
  key: AggregatableMetric,
): number[] {
  const out: number[] = []
  for (const m of metrics) {
    const v = m.byYear[year]?.[key]
    if (isMeaningful(v as Multiple) || usable(v)) out.push(v as number)
  }
  return out
}

/**
 * Summarise a peer group for a single year.
 *
 * `members` is the full roster so the UI can show "14 of 19 with data" rather
 * than silently narrowing the group.
 */
export function summariseGroup(
  group: string,
  metrics: CompanyMetrics[],
  year: string,
): GroupSummary {
  const stats: Partial<Record<AggregatableMetric, GroupStat>> = {}
  const sample = metrics[0]?.byYear[year]
  const keys = (sample ? Object.keys(sample) : []).filter(
    (k) => !EXCLUDED.has(k),
  ) as AggregatableMetric[]

  for (const key of keys) {
    const values = collect(metrics, year, key)
    stats[key] = { mean: mean(values), median: median(values), n: values.length }
  }

  return { group, year, members: metrics.map((m) => m.ticker), stats }
}

/** Summarise every named group for one year. */
export function summariseGroups(
  groups: Record<string, string[]>,
  metricsByTicker: Record<string, CompanyMetrics>,
  year: string,
): GroupSummary[] {
  return Object.entries(groups).map(([group, tickers]) => {
    const members = tickers
      .map((t) => metricsByTicker[t])
      .filter((m): m is CompanyMetrics => Boolean(m))
    return summariseGroup(group, members, year)
  })
}

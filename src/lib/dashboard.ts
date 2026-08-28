import { computeMetrics, type CompanyMetrics } from './metrics.js'
import { resolveCompany, tierBreakdown, type TierInputs } from './resolve.js'
import { summariseGroups, type GroupSummary } from './aggregate.js'
import type { Universe } from './store.js'
import type {
  CompanyMeta,
  FactSetCache,
  OverrideStore,
  OwnModel,
  ResolvedCompany,
  Tier,
} from './types.js'

/**
 * Assembles the dashboard: resolve every company across the three tiers, then
 * derive metrics and peer-group roll-ups from the resolved numbers.
 */

export interface DashboardInputs {
  universe: Universe
  factset: FactSetCache
  overrides: OverrideStore
  models: Record<string, OwnModel>
}

export interface CompanyView {
  meta: CompanyMeta
  resolved: ResolvedCompany
  metrics: CompanyMetrics
  tierCounts: Record<Tier, number>
}

export interface Dashboard {
  asOf: string | null
  factsetSource: string
  companies: CompanyView[]
  years: string[]
  sectorSummaries: GroupSummary[]
  peerSummaries: GroupSummary[]
  /** Year the summaries were struck on. */
  summaryYear: string
}

function tiersFor(ticker: string, inputs: DashboardInputs): TierInputs {
  return {
    factset: inputs.factset.companies[ticker],
    model: inputs.models[ticker],
    override: inputs.overrides.companies[ticker],
  }
}

/**
 * Default year for the summary tables: the last year for which a majority of
 * the universe carries a revenue estimate. Picking the furthest year available
 * would key the sector medians off a handful of long-dated forecasts.
 */
export function defaultSummaryYear(companies: CompanyView[]): string {
  const counts = new Map<string, number>()
  for (const company of companies) {
    for (const [year, cell] of Object.entries(company.resolved.series.revenue)) {
      if (cell.value !== null) counts.set(year, (counts.get(year) ?? 0) + 1)
    }
  }
  if (!counts.size) return String(new Date().getFullYear())
  const quorum = Math.max(...counts.values()) / 2
  const years = [...counts.entries()]
    .filter(([, n]) => n >= quorum)
    .map(([year]) => year)
    .sort()
  return years[years.length - 1] ?? String(new Date().getFullYear())
}

export function buildDashboard(inputs: DashboardInputs, summaryYear?: string): Dashboard {
  const companies: CompanyView[] = inputs.universe.companies.map((meta) => {
    const resolved = resolveCompany(meta, tiersFor(meta.ticker, inputs))
    return {
      meta,
      resolved,
      metrics: computeMetrics(resolved),
      tierCounts: tierBreakdown(resolved),
    }
  })

  const years = [...new Set(companies.flatMap((c) => c.metrics.years))].sort()
  const year = summaryYear ?? defaultSummaryYear(companies)

  const metricsByTicker: Record<string, CompanyMetrics> = {}
  for (const company of companies) metricsByTicker[company.meta.ticker] = company.metrics

  return {
    asOf: inputs.factset.asOf || null,
    factsetSource: inputs.factset.source,
    companies,
    years,
    summaryYear: year,
    sectorSummaries: summariseGroups(inputs.universe.sectors, metricsByTicker, year),
    peerSummaries: summariseGroups(inputs.universe.peerGroups, metricsByTicker, year),
  }
}

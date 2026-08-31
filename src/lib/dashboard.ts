import { computeMetrics, type CompanyMetrics } from './metrics.js'
import { resolveCompany, tierBreakdown, type TierInputs } from './resolve.js'
import { summariseGroups, type GroupSummary } from './aggregate.js'
import type { Universe } from './store.js'
import type {
  PriceUpdateReport,
  CompanyMeta,
  FactSetCache,
  MetricKey,
  OverrideStore,
  OwnModel,
  ResolvedCompany,
  Series,
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
  /**
   * The FactSet tier on its own, alongside the resolved view. Where a model or
   * override wins, the consensus it displaced is invisible in `resolved`, and
   * tracking estimate revisions requires seeing the vendor number regardless
   * of who won the cell.
   */
  factset: { price: number | null; series: Partial<Record<MetricKey, Series>> } | null
  /**
   * Year-to-date return, computed from the live price over the prior year's
   * final close rather than stored. A stored return goes stale the moment the
   * price moves; this one cannot.
   */
  ytdReturn: number | null
  /**
   * The YTD denominator in effect: a hand-entered override beats the fetched
   * baseline, so a name the free feed cannot price can still carry a return.
   */
  priorYearClose: { value: number | null; tier: 'override' | 'factset' | null }
}

export interface Dashboard {
  asOf: string | null
  /** When prices were last updated by the free EOD feed, if ever. */
  pricesAsOf: string | null
  /** Outcome of the most recent price update, whatever the source. */
  priceUpdate: PriceUpdateReport | null
  factsetSource: string
  companies: CompanyView[]
  years: string[]
  sectorSummaries: GroupSummary[]
  peerSummaries: GroupSummary[]
  /** Year the summaries were struck on. */
  summaryYear: string
  /** Set by the server when a FactSet pull is in flight; absent otherwise. */
  factsetRefreshing?: boolean
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
    const vendor = inputs.factset.companies[meta.ticker]
    const metrics = computeMetrics(resolved)
    const overrideClose = inputs.overrides.companies[meta.ticker]?.priorYearClose
    const priorClose =
      typeof overrideClose === 'number' ? overrideClose : vendor?.priorYearClose
    return {
      meta,
      resolved,
      metrics,
      tierCounts: tierBreakdown(resolved),
      factset: vendor ? { price: vendor.price ?? null, series: vendor.series ?? {} } : null,
      ytdReturn:
        typeof priorClose === 'number' && priorClose > 0 && metrics.price !== null
          ? metrics.price / priorClose - 1
          : null,
      priorYearClose: {
        value: typeof priorClose === 'number' ? priorClose : null,
        tier:
          typeof overrideClose === 'number'
            ? 'override'
            : typeof vendor?.priorYearClose === 'number'
              ? 'factset'
              : null,
      },
    }
  })

  const years = [...new Set(companies.flatMap((c) => c.metrics.years))].sort()
  const year = summaryYear ?? defaultSummaryYear(companies)

  const metricsByTicker: Record<string, CompanyMetrics> = {}
  for (const company of companies) metricsByTicker[company.meta.ticker] = company.metrics

  return {
    asOf: inputs.factset.asOf || null,
    pricesAsOf: inputs.factset.pricesAsOf || null,
    priceUpdate: inputs.factset.lastPriceUpdate ?? null,
    factsetSource: inputs.factset.source,
    companies,
    years,
    summaryYear: year,
    sectorSummaries: summariseGroups(inputs.universe.sectors, metricsByTicker, year),
    peerSummaries: summariseGroups(inputs.universe.peerGroups, metricsByTicker, year),
  }
}

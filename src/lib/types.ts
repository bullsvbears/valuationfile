/**
 * Domain types for the valuation dashboard.
 *
 * The model mirrors the structure of the original Software Valuation File:
 * a per-ticker set of annual series (revenue, gross profit, EBITDA, EPS, FCF)
 * plus point-in-time balance sheet items, from which every valuation multiple
 * on the dashboard is derived.
 */

/** Annual line items carried per company, keyed by calendar year. */
export const METRIC_KEYS = ['revenue', 'grossProfit', 'ebitda', 'eps', 'fcf'] as const
export type MetricKey = (typeof METRIC_KEYS)[number]

/** Point-in-time items used to bridge market cap to enterprise value. */
export const BALANCE_KEYS = ['shares', 'cash', 'debt'] as const
export type BalanceKey = (typeof BALANCE_KEYS)[number]

/**
 * Where a number came from, in ascending order of precedence.
 *
 * - `factset`  estimates pulled from FactSet, the default for every company
 * - `model`    the analyst's own model, for companies they cover
 * - `override` a deliberate manual edit, which trumps everything
 *
 * In the source workbook these three tiers existed but were indistinguishable
 * once entered: a FactSet `FE_ESTIMATE` call, a typed-in actual, and a link to
 * an external model workbook all looked like plain numbers. Tracking the tier
 * explicitly is what makes the override workflow safe.
 */
export const TIERS = ['factset', 'model', 'override'] as const
export type Tier = (typeof TIERS)[number]

/** Precedence used by the resolver. Later entries win. */
export const TIER_PRECEDENCE: readonly Tier[] = ['factset', 'model', 'override']

export type Series = Partial<Record<string, number | null>>

/** One tier's contribution for a single company. */
export interface CompanyFacts {
  series: Partial<Record<MetricKey, Series>>
  balance?: Partial<Record<BalanceKey, number | null>>
  price?: number | null
}

/** Static, non-numeric company attributes. */
export interface CompanyMeta {
  ticker: string
  name: string
  /** Calendar month the fiscal year ends in (1-12). Drives FactSet ANN vs CALA. */
  fiscalYearEnd: number | null
  /** Coverage bucket from the source file, e.g. "Bhatia - Covered Companies". */
  coverage: string | null
  /** True when the analyst maintains their own model for this name. */
  covered: boolean
  sectors: string[]
  peerGroups: string[]
}

/** The FactSet tier: bulk data refreshed from the vendor. */
export interface FactSetCache {
  /** ISO timestamp of the last successful refresh. */
  asOf: string
  /** Free-form note describing how the cache was produced. */
  source: string
  companies: Record<string, CompanyFacts>
}

/** The override tier: sparse, hand-entered corrections keyed by ticker. */
export interface OverrideStore {
  companies: Record<string, OverrideEntry>
}

export interface OverrideEntry extends CompanyFacts {
  /** Why the override exists, surfaced in the UI so edits stay auditable. */
  notes?: Partial<Record<string, string>>
  updatedAt?: string
}

/** The model tier: a full owned model for a covered company. */
export interface OwnModel extends CompanyFacts {
  ticker: string
  updatedAt?: string
  /** Analyst-authored commentary shown on the company page. */
  thesis?: string
}

/** A single resolved number plus the tier that supplied it. */
export interface Resolved {
  value: number | null
  tier: Tier | null
  /** Tiers that had a value but lost to a higher-precedence one. */
  shadowed: Tier[]
}

export type ResolvedSeries = Record<string, Resolved>

/** Fully resolved inputs for one company, ready for the metrics engine. */
export interface ResolvedCompany {
  meta: CompanyMeta
  price: Resolved
  balance: Record<BalanceKey, Resolved>
  series: Record<MetricKey, ResolvedSeries>
}

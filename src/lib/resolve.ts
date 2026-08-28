import {
  BALANCE_KEYS,
  METRIC_KEYS,
  TIER_PRECEDENCE,
  type BalanceKey,
  type CompanyFacts,
  type CompanyMeta,
  type MetricKey,
  type Resolved,
  type ResolvedCompany,
  type ResolvedSeries,
  type Tier,
} from './types.js'

/** The three tiers for one company, lowest precedence first. */
export interface TierInputs {
  factset?: CompanyFacts
  model?: CompanyFacts
  override?: CompanyFacts
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * Pick the winning value for a single cell.
 *
 * Walks the tiers from lowest to highest precedence so the last tier holding a
 * usable number wins, and records the tiers it displaced. A tier that carries
 * an explicit `null` is treated as "no opinion" and falls through, which lets a
 * model define only the forward years it actually forecasts.
 */
function pick(candidates: Partial<Record<Tier, number | null | undefined>>): Resolved {
  let value: number | null = null
  let tier: Tier | null = null
  const shadowed: Tier[] = []

  for (const t of TIER_PRECEDENCE) {
    if (!isNumber(candidates[t])) continue
    if (tier) shadowed.push(tier)
    value = candidates[t] as number
    tier = t
  }
  return { value, tier, shadowed }
}

/** Every year mentioned by any tier for a given metric, sorted ascending. */
function yearsFor(inputs: TierInputs, metric: MetricKey): string[] {
  const years = new Set<string>()
  for (const t of TIER_PRECEDENCE) {
    const series = inputs[t]?.series?.[metric]
    if (series) for (const y of Object.keys(series)) years.add(y)
  }
  return [...years].sort()
}

function resolveSeries(inputs: TierInputs, metric: MetricKey): ResolvedSeries {
  const out: ResolvedSeries = {}
  for (const year of yearsFor(inputs, metric)) {
    out[year] = pick({
      factset: inputs.factset?.series?.[metric]?.[year],
      model: inputs.model?.series?.[metric]?.[year],
      override: inputs.override?.series?.[metric]?.[year],
    })
  }
  return out
}

/**
 * Collapse the FactSet, own-model and override tiers into one set of inputs.
 *
 * This is the single place precedence is decided, so the dashboard, the export
 * and the tests all agree on which number is live for any given cell.
 */
export function resolveCompany(meta: CompanyMeta, inputs: TierInputs): ResolvedCompany {
  const series = {} as Record<MetricKey, ResolvedSeries>
  for (const metric of METRIC_KEYS) series[metric] = resolveSeries(inputs, metric)

  const balance = {} as Record<BalanceKey, Resolved>
  for (const key of BALANCE_KEYS) {
    balance[key] = pick({
      factset: inputs.factset?.balance?.[key],
      model: inputs.model?.balance?.[key],
      override: inputs.override?.balance?.[key],
    })
  }

  const price = pick({
    factset: inputs.factset?.price,
    model: inputs.model?.price,
    override: inputs.override?.price,
  })

  return { meta, price, balance, series }
}

/** Count of live cells contributed by each tier, used for the provenance bar. */
export function tierBreakdown(company: ResolvedCompany): Record<Tier, number> {
  const counts: Record<Tier, number> = { factset: 0, model: 0, override: 0 }
  for (const metric of METRIC_KEYS) {
    for (const cell of Object.values(company.series[metric])) {
      if (cell.tier) counts[cell.tier] += 1
    }
  }
  for (const cell of Object.values(company.balance)) {
    if (cell.tier) counts[cell.tier] += 1
  }
  return counts
}

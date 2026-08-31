import type { Dashboard } from './dashboard.js'
import type { MetricKey } from './types.js'

/**
 * The Summary tab's mover computation: what changed in the master inputs
 * (from any source), price moves, multiple re-ratings, and the comp groups
 * seeing the input changes — all measured against a history snapshot.
 *
 * Shared by the Summary tab and the Excel export so the two can never drift.
 */

const ESTIMATE_METRICS: { key: MetricKey; label: string }[] = [
  { key: 'revenue', label: 'Revenue' },
  { key: 'ebitda', label: 'EBITDA' },
  { key: 'fcf', label: 'FCF' },
  { key: 'eps', label: 'EPS' },
]

/** A move smaller than this is noise, not news. */
export const ESTIMATE_THRESHOLD = 0.01
export const PRICE_THRESHOLD = 0.03
export const MULTIPLE_THRESHOLD = 0.05
const MAX_ROWS = 15

export function pct(value: number): string {
  const text = (value * 100).toFixed(1)
  return value > 0 ? `+${text}%` : `${text}%`
}

export function money(value: number, cents: boolean): string {
  const sign = value < 0 ? '-' : ''
  return `${sign}$${Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  })}`
}

export interface Mover {
  ticker: string
  detail: string
  then: string
  now: string
  percent: number
  /** Tier owning the cell now, shown as a source dot. */
  tier?: string | null
}

export interface GroupMover {
  group: string
  kind: 'Sector' | 'Financial'
  changed: number
  total: number
  medianMove: number
}

/** The slice of a history snapshot the mover computation reads. */
export interface MoverSnapshot {
  companies: Record<string, {
    price?: number | null
    series?: Partial<Record<string, Record<string, number>>>
    multiples?: Record<string, Partial<Record<string, number>>>
  }>
}

export interface Movers {
  estimates: Mover[]
  prices: Mover[]
  multiples: Mover[]
  groups: GroupMover[]
}

export function computeMovers(
  dashboard: Dashboard,
  snapshot: MoverSnapshot,
  year: string,
): Movers {
  const estimates: Mover[] = []
  const prices: Mover[] = []
  const multiples: Mover[] = []
  const groups: GroupMover[] = []

  /** Largest input move per ticker, for the group roll-up. */
  const biggestMove = new Map<string, number>()

  for (const company of dashboard.companies) {
    const ticker = company.meta.ticker
    const past = snapshot.companies[ticker]
    if (!past) continue

    // Master-input changes: resolved then vs resolved now, any source.
    // One row per company — its biggest move — so a name whose four inputs
    // all shifted together cannot crowd everything else off the panel.
    let best: Mover | null = null
    let movedInputs = 0
    for (const { key, label } of ESTIMATE_METRICS) {
      const then = past.series?.[key]?.[year]
      const now = company.resolved.series[key][year]?.value ?? null
      if (typeof then !== 'number' || typeof now !== 'number' || then === 0) continue
      const move = (now - then) / Math.abs(then)
      if (Math.abs(move) > Math.abs(biggestMove.get(ticker) ?? 0)) {
        biggestMove.set(ticker, move)
      }
      if (Math.abs(move) < ESTIMATE_THRESHOLD) continue
      const cents = key === 'eps'
      // A change the formatting cannot show ($0.00 to $0.00) is noise here,
      // whatever its percentage: the base is too small to matter.
      if (money(then, cents) === money(now, cents)) continue
      movedInputs += 1
      if (!best || Math.abs(move) > Math.abs(best.percent)) {
        best = {
          ticker,
          detail: `${label} ${year}`,
          then: money(then, cents),
          now: money(now, cents),
          percent: move,
          tier: company.resolved.series[key][year]?.tier,
        }
      }
    }
    if (best) {
      if (movedInputs > 1) best.detail += ` · ${movedInputs} inputs moved`
      estimates.push(best)
    }

    // Price moves.
    const priceThen = past.price
    const priceNow = company.metrics.price
    if (typeof priceThen === 'number' && typeof priceNow === 'number' && priceThen !== 0) {
      const move = (priceNow - priceThen) / Math.abs(priceThen)
      if (Math.abs(move) >= PRICE_THRESHOLD) {
        prices.push({
          ticker,
          detail: company.meta.name,
          then: money(priceThen, true),
          now: money(priceNow, true),
          percent: move,
        })
      }
    }

    // EV/Revenue re-ratings.
    const multThen = past.multiples?.[year]?.evRevenue
    const multNow = company.metrics.byYear[year]?.evRevenue
    if (typeof multThen === 'number' && typeof multNow === 'number' && multThen !== 0) {
      const move = (multNow - multThen) / Math.abs(multThen)
      if (Math.abs(move) >= MULTIPLE_THRESHOLD) {
        multiples.push({
          ticker,
          detail: `EV/Rev ${year}`,
          then: `${multThen.toFixed(1)}x`,
          now: `${multNow.toFixed(1)}x`,
          percent: move,
        })
      }
    }
  }

  // Roll the same input changes up by comp group: a name counts as changed
  // when its largest input move for the year clears the threshold.
  const summaries = [
    ...dashboard.sectorSummaries.map((s) => ({ ...s, kind: 'Sector' as const })),
    ...dashboard.peerSummaries.map((s) => ({ ...s, kind: 'Financial' as const })),
  ]
  for (const summary of summaries) {
    const moves = summary.members
      .map((t) => biggestMove.get(t) ?? null)
      .filter((m): m is number => m !== null)
    const changedMoves = moves.filter((m) => Math.abs(m) >= ESTIMATE_THRESHOLD)
    if (!changedMoves.length) continue
    const sorted = [...changedMoves].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    const medianMove =
      sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
    groups.push({
      group: summary.group,
      kind: summary.kind,
      changed: changedMoves.length,
      total: summary.members.length,
      medianMove,
    })
  }
  groups.sort(
    (a, b) => b.changed / Math.max(b.total, 1) - a.changed / Math.max(a.total, 1) || b.changed - a.changed,
  )

  const byMagnitude = (a: Mover, b: Mover) => Math.abs(b.percent) - Math.abs(a.percent)
  return {
    estimates: estimates.sort(byMagnitude).slice(0, MAX_ROWS),
    prices: prices.sort(byMagnitude).slice(0, MAX_ROWS),
    multiples: multiples.sort(byMagnitude).slice(0, MAX_ROWS),
    groups: groups.slice(0, MAX_ROWS),
  }
}

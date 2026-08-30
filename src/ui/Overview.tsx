import { useEffect, useMemo, useState } from 'react'
import type { Dashboard } from '../lib/dashboard.js'
import type { MetricKey } from '../lib/types.js'
import { api, type HistorySnapshot } from './api.js'

/**
 * Summary: the day's landing page — what moved in the master inputs.
 *
 * Changes are measured on the resolved values, the numbers the Master Input
 * tab shows, so a FactSet revision, a model update and a hand override all
 * count equally — the question is "which companies' data moved", not "who
 * moved it". Each row still carries a source dot for the tier that owns the
 * cell now. A fourth panel rolls the same changes up by comp group, so a
 * sector-wide estimate reset reads as one line rather than twenty.
 * Thresholds keep it to moves worth reading; the Changes tab holds the full
 * list.
 */

const ESTIMATE_METRICS: { key: MetricKey; label: string }[] = [
  { key: 'revenue', label: 'Revenue' },
  { key: 'ebitda', label: 'EBITDA' },
  { key: 'fcf', label: 'FCF' },
  { key: 'eps', label: 'EPS' },
]

/** A move smaller than this is noise, not news. */
const ESTIMATE_THRESHOLD = 0.01
const PRICE_THRESHOLD = 0.03
const MULTIPLE_THRESHOLD = 0.05
const MAX_ROWS = 15

function pct(value: number): string {
  const text = (value * 100).toFixed(1)
  return value > 0 ? `+${text}%` : `${text}%`
}

function money(value: number, cents: boolean): string {
  const sign = value < 0 ? '-' : ''
  return `${sign}$${Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  })}`
}

interface Mover {
  ticker: string
  detail: string
  then: string
  now: string
  percent: number
  /** Tier owning the cell now, shown as a source dot. */
  tier?: string | null
}

interface GroupMover {
  group: string
  kind: 'Sector' | 'Financial'
  changed: number
  total: number
  medianMove: number
}

function MoverTable({ title, sub, rows, empty }: {
  title: string
  sub: string
  rows: Mover[]
  empty: string
}) {
  return (
    <div className="panel overview-panel">
      <h3>{title}</h3>
      <p className="sub">{sub}</p>
      {rows.length === 0 ? (
        <p className="hint">{empty}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="left">Company</th>
              <th>Then</th>
              <th>Now</th>
              <th>%Δ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={`${row.ticker}-${row.detail}-${i}`}>
                <td className="left">
                  <span className="master-ticker">{row.ticker}</span>
                  {row.tier && <i className={`tier-dot ${row.tier}`} title={`Source: ${row.tier}`} />}
                  <span className="hint" style={{ marginLeft: 6 }}>{row.detail}</span>
                </td>
                <td className="num">{row.then}</td>
                <td className="num">{row.now}</td>
                <td className={`num ${row.percent > 0 ? 'pos' : 'neg'}`}>{pct(row.percent)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export function Overview({ dashboard }: { dashboard: Dashboard }) {
  const [dates, setDates] = useState<string[] | null>(null)
  const [compareTo, setCompareTo] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<HistorySnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)

  const today = new Date().toISOString().slice(0, 10)
  const year = dashboard.summaryYear

  useEffect(() => {
    api
      .historyDates()
      .then(({ dates: all }) => {
        setDates(all)
        // Default to the most recent snapshot before today: "since yesterday".
        const prior = all.filter((d) => d < today)
        setCompareTo(prior.length ? (prior[prior.length - 1] as string) : null)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!compareTo) return
    setSnapshot(null)
    api
      .historySnapshot(compareTo)
      .then(setSnapshot)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [compareTo])

  const { estimates, prices, multiples, groups } = useMemo(() => {
    const estimates: Mover[] = []
    const prices: Mover[] = []
    const multiples: Mover[] = []
    const groups: GroupMover[] = []
    if (!snapshot) return { estimates, prices, multiples, groups }

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
  }, [dashboard, snapshot, year])

  if (error) return <div className="status error">{error}</div>
  if (dates === null) return <div className="loading">Loading…</div>

  const priorDates = dates.filter((d) => d < today)

  if (!priorDates.length) {
    return (
      <div className="panel">
        <h3>Summary</h3>
        <p className="sub">
          Nothing to summarise yet: today's snapshot is the first one recorded.
          The dashboard stores its state once per day it is used — from tomorrow,
          this page will lead with the input changes (from any source), the comp
          groups seeing them, price moves and multiple re-ratings since a date
          you pick.
        </p>
      </div>
    )
  }

  return (
    <>
      <div className="controls">
        <div className="control">
          <label htmlFor="ov-date">Changes since</label>
          <select
            id="ov-date"
            value={compareTo ?? ''}
            onChange={(e) => setCompareTo(e.target.value)}
          >
            {priorDates.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </div>
        <span className="count">
          {estimates.length + prices.length + multiples.length} highlighted moves · full detail on the Changes tab
        </span>
      </div>

      <div className="overview-grid">
        <MoverTable
          title="Input changes"
          sub={`Master-input moves of 1%+ for ${year} — FactSet revisions, model updates and overrides alike; the dot marks the source.`}
          rows={estimates}
          empty="No input has moved 1% or more."
        />
        <div className="panel overview-panel">
          <h3>Comp groups seeing changes</h3>
          <p className="sub">
            Groups ranked by how much of the membership has a changed input for {year}.
          </p>
          {groups.length === 0 ? (
            <p className="hint">No group has a changed member.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th className="left">Group</th>
                  <th>Changed</th>
                  <th>Median Δ</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={`${g.kind}-${g.group}`}>
                    <td className="left">
                      {g.group}
                      <span className="hint" style={{ marginLeft: 6 }}>{g.kind}</span>
                    </td>
                    <td className="num">{g.changed} of {g.total}</td>
                    <td className={`num ${g.medianMove > 0 ? 'pos' : 'neg'}`}>{pct(g.medianMove)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <MoverTable
          title="Price moves"
          sub="Shares that have moved 3% or more."
          rows={prices}
          empty="No price has moved 3% or more."
        />
        <MoverTable
          title="Multiple re-ratings"
          sub={`EV/Revenue for ${year} moving 5% or more — price and estimates combined.`}
          rows={multiples}
          empty="No EV/Revenue multiple has moved 5% or more."
        />
      </div>
    </>
  )
}

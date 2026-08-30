import { useEffect, useMemo, useState } from 'react'
import type { Dashboard } from '../lib/dashboard.js'
import type { MetricKey } from '../lib/types.js'
import { api, type HistorySnapshot } from './api.js'

/**
 * Summary: the day's landing page — what moved.
 *
 * Three panels of movers since a chosen snapshot date: FactSet estimate
 * revisions (the vendor tier specifically, so a revision shows even where an
 * own model or override wins the resolved cell), price moves, and EV/Revenue
 * re-ratings. Thresholds keep it to changes worth reading; the Changes tab
 * holds the full list.
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

  const { estimates, prices, multiples } = useMemo(() => {
    const estimates: Mover[] = []
    const prices: Mover[] = []
    const multiples: Mover[] = []
    if (!snapshot) return { estimates, prices, multiples }

    for (const company of dashboard.companies) {
      const ticker = company.meta.ticker
      const past = snapshot.companies[ticker]
      if (!past) continue

      // FactSet estimate revisions, vendor tier against vendor tier.
      for (const { key, label } of ESTIMATE_METRICS) {
        const then = past.factset?.series?.[key]?.[year]
        const now = company.factset?.series?.[key]?.[year]
        if (typeof then !== 'number' || typeof now !== 'number' || then === 0) continue
        const move = (now - then) / Math.abs(then)
        if (Math.abs(move) < ESTIMATE_THRESHOLD) continue
        const cents = key === 'eps'
        estimates.push({
          ticker,
          detail: `${label} ${year}`,
          then: money(then, cents),
          now: money(now, cents),
          percent: move,
        })
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

    const byMagnitude = (a: Mover, b: Mover) => Math.abs(b.percent) - Math.abs(a.percent)
    return {
      estimates: estimates.sort(byMagnitude).slice(0, MAX_ROWS),
      prices: prices.sort(byMagnitude).slice(0, MAX_ROWS),
      multiples: multiples.sort(byMagnitude).slice(0, MAX_ROWS),
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
          this page will lead with the FactSet estimate revisions, price moves
          and multiple re-ratings since a date you pick.
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
          title="FactSet estimate revisions"
          sub={`Consensus moves of 1%+ for ${year}, whether or not your model overrides them.`}
          rows={estimates}
          empty="No consensus estimate has moved 1% or more."
        />
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

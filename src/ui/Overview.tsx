import { useEffect, useMemo, useState } from 'react'
import type { Dashboard } from '../lib/dashboard.js'
import { computeMovers, pct, type Mover } from '../lib/movers.js'
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

  const { estimates, prices, multiples, groups } = useMemo(
    () =>
      snapshot
        ? computeMovers(dashboard, snapshot, year)
        : { estimates: [], prices: [], multiples: [], groups: [] },
    [dashboard, snapshot, year],
  )

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

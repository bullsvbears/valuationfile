import { useEffect, useMemo, useState } from 'react'
import type { Dashboard } from '../lib/dashboard.js'
import type { MetricKey } from '../lib/types.js'
import { api, type HistorySnapshot } from './api.js'

/**
 * Changes: how the key inputs have moved since an earlier snapshot.
 *
 * The server records the state once per day, and this tab compares the live
 * numbers against any recorded date. The default source is the master inputs
 * (the resolved values — FactSet, model or override, whichever owns the
 * cell); "FactSet estimates only" isolates consensus revisions, which stay
 * visible even where a model or override wins the resolved cell.
 */

type Source = 'factset' | 'resolved'

const METRIC_TABS: { key: MetricKey | 'price'; label: string }[] = [
  { key: 'revenue', label: 'Revenue' },
  { key: 'grossProfit', label: 'Gross profit' },
  { key: 'ebitda', label: 'EBITDA' },
  { key: 'eps', label: 'EPS' },
  { key: 'fcf', label: 'Free cash flow' },
  { key: 'price', label: 'Price' },
]

function fmt(value: number | null, cents: boolean): string {
  if (value === null) return '—'
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  return `${sign}$${abs.toLocaleString('en-US', {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  })}`
}

function fmtDelta(value: number | null, cents: boolean): string {
  if (value === null) return '—'
  const body = fmt(value, cents)
  return value > 0 ? `+${body}` : body
}

function fmtPercent(value: number | null): string {
  if (value === null) return '—'
  const pct = (value * 100).toFixed(1)
  return value > 0 ? `+${pct}%` : `${pct}%`
}

interface Row {
  ticker: string
  name: string
  then: number | null
  now: number | null
  delta: number | null
  percent: number | null
}

export function Changes({ dashboard }: { dashboard: Dashboard }) {
  const [dates, setDates] = useState<string[] | null>(null)
  const [compareTo, setCompareTo] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<HistorySnapshot | null>(null)
  const [metric, setMetric] = useState<MetricKey | 'price'>('revenue')
  const [year, setYear] = useState(dashboard.summaryYear)
  const [search, setSearch] = useState('')
  const [source, setSource] = useState<Source>('resolved')
  const [sort, setSort] = useState<'moved' | 'ticker'>('moved')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .historyDates()
      .then(({ dates: all }) => {
        setDates(all)
        // Default to the oldest snapshot: the widest window shows the most.
        if (all.length) setCompareTo(all[0] as string)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  useEffect(() => {
    if (!compareTo) return
    setSnapshot(null)
    api
      .historySnapshot(compareTo)
      .then(setSnapshot)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [compareTo])

  const cents = metric === 'eps' || metric === 'price'

  const rows = useMemo<Row[]>(() => {
    if (!snapshot) return []
    const needle = search.trim().toLowerCase()
    const out: Row[] = []

    for (const company of dashboard.companies) {
      const ticker = company.meta.ticker
      if (
        needle &&
        !ticker.toLowerCase().includes(needle) &&
        !company.meta.name.toLowerCase().includes(needle)
      ) continue

      const past = snapshot.companies[ticker]
      let then: number | null
      let now: number | null
      if (metric === 'price') {
        // Price is a market fact, the same number under either source.
        then = past?.price ?? null
        now = company.metrics.price
      } else if (source === 'factset') {
        then = past?.factset?.series?.[metric]?.[year] ?? null
        now = (company.factset?.series?.[metric]?.[year] as number | undefined) ?? null
      } else {
        then = past?.series?.[metric]?.[year] ?? null
        now = company.resolved.series[metric][year]?.value ?? null
      }

      const delta = then !== null && now !== null ? now - then : null
      const percent = delta !== null && then !== null && then !== 0 ? delta / Math.abs(then) : null
      out.push({ ticker, name: company.meta.name, then, now, delta, percent })
    }

    if (sort === 'ticker') return out.sort((a, b) => a.ticker.localeCompare(b.ticker))
    // Biggest movers first; rows with nothing to compare sink to the bottom.
    const rank = (row: Row) => (row.percent === null ? -Infinity : Math.abs(row.percent))
    return out.sort((a, b) => rank(b) - rank(a) || a.ticker.localeCompare(b.ticker))
  }, [dashboard, snapshot, metric, year, search, sort, source])

  const changed = rows.filter((r) => r.delta !== null && Math.abs(r.delta) > 1e-9).length

  if (error) return <div className="status error">{error}</div>
  if (dates === null) return <div className="loading">Loading history…</div>

  return (
    <>
      <div className="controls">
        <nav className="tabs metric-tabs">
          {METRIC_TABS.map((tab) => (
            <button
              key={tab.key}
              className="tab"
              aria-selected={metric === tab.key}
              onClick={() => setMetric(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        {metric !== 'price' && (
          <div className="control">
            <label htmlFor="chg-year">Year</label>
            <select id="chg-year" value={year} onChange={(e) => setYear(e.target.value)}>
              {dashboard.years.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
        )}
        <div className="control">
          <label htmlFor="chg-source">Source</label>
          <select
            id="chg-source"
            value={source}
            onChange={(e) => setSource(e.target.value as Source)}
          >
            <option value="resolved">Master inputs (any source)</option>
            <option value="factset">FactSet estimates only</option>
          </select>
        </div>
        <div className="control">
          <label htmlFor="chg-date">Compare to</label>
          <select
            id="chg-date"
            value={compareTo ?? ''}
            onChange={(e) => setCompareTo(e.target.value)}
          >
            {dates.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </div>
        <div className="control">
          <label htmlFor="chg-search">Search</label>
          <input
            id="chg-search"
            type="text"
            value={search}
            placeholder="Ticker or company"
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <span className="count">{changed} of {rows.length} moved</span>
      </div>

      {dates.length <= 1 && (
        <div className="status">
          A snapshot is recorded automatically each day the dashboard is used, and
          today's is the first. Differences will appear here once estimates,
          prices or your inputs move against a recorded day.
        </div>
      )}

      {snapshot && (
        <div className="table-wrap" style={{ maxWidth: 860 }}>
          <table>
            <thead>
              <tr>
                <th className="left sticky-col" onClick={() => setSort('ticker')}>
                  Company{sort === 'ticker' ? ' ▴' : ''}
                </th>
                <th>{compareTo}</th>
                <th>Today</th>
                <th>Δ</th>
                <th onClick={() => setSort('moved')}>%Δ{sort === 'moved' ? ' ▾' : ''}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const dir = (row.delta ?? 0) > 1e-9 ? 'pos' : (row.delta ?? 0) < -1e-9 ? 'neg' : ''
                return (
                  <tr key={row.ticker}>
                    <td className="left sticky-col">
                      <span className="master-ticker">{row.ticker}</span>
                      <div className="company-name">{row.name}</div>
                    </td>
                    <td className="num">{fmt(row.then, cents)}</td>
                    <td className="num">{fmt(row.now, cents)}</td>
                    <td className={`num ${dir}`}>{fmtDelta(row.delta, cents)}</td>
                    <td className={`num ${dir}`}>{fmtPercent(row.percent)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

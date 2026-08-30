import { useEffect, useMemo, useState } from 'react'
import { api, type CompanyDetail as Detail } from './api.js'
import { METRIC_KEYS, type MetricKey } from '../lib/types.js'
import {
  formatMillions,
  formatMultiple,
  formatNumber,
  formatPercent,
  formatPrice,
} from './format.js'

/**
 * Company page: a read-only view of one name.
 *
 * All editing happens on the Companies Master tab, so every other view —
 * this one included — is a pure function of what the master resolves. The
 * inputs table still shows each cell's source, and for any cell where a
 * higher tier won, the FactSet consensus it displaced.
 */

const METRIC_LABELS: Record<MetricKey, string> = {
  revenue: 'Revenue',
  grossProfit: 'Gross profit',
  ebitda: 'EBITDA',
  fcf: 'Free cash flow',
  eps: 'EPS',
}

export function CompanyDetail({ ticker, onBack }: { ticker: string; onBack: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDetail(null)
    api
      .company(ticker)
      .then(setDetail)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [ticker])

  const years = useMemo(() => {
    if (!detail) return []
    const all = new Set<string>()
    for (const metric of METRIC_KEYS) {
      for (const year of Object.keys(detail.resolved.series[metric])) all.add(year)
    }
    return [...all].sort()
  }, [detail])

  if (error) return <div className="status error">{error}</div>
  if (!detail) return <div className="loading">Loading {ticker}…</div>

  const { meta, metrics, resolved, tiers } = detail

  return (
    <div className="detail">
      <div className="panel">
        <div className="controls" style={{ marginBottom: 10 }}>
          <button className="back" onClick={onBack}>← All companies</button>
          <div className="spacer" />
          {meta.covered && <span className="badge covered">Covered · {meta.coverage}</span>}
          {tiers.model && <span className="badge model">Own model</span>}
        </div>

        <h2>{meta.ticker} · {meta.name}</h2>
        <p className="sub">
          {meta.sectors.join(', ') || 'Unclassified'}
          {meta.fiscalYearEnd ? ` · FY ends month ${meta.fiscalYearEnd}` : ''}
        </p>

        <div className="stat-row">
          <div className="stat">
            <div className="label">Price</div>
            <div className="value">{formatPrice(metrics.price)}</div>
          </div>
          <div className="stat">
            <div className="label">Market cap</div>
            <div className="value">{formatMillions(metrics.marketCap)}</div>
          </div>
          <div className="stat">
            <div className="label">Enterprise value</div>
            <div className="value">{formatMillions(metrics.enterpriseValue)}</div>
          </div>
          <div className="stat">
            <div className="label">Diluted shares</div>
            <div className="value">{formatNumber(resolved.balance.shares.value, 1)}</div>
          </div>
          <div className="stat">
            <div className="label">Net debt</div>
            <div className="value">
              {formatMillions(
                resolved.balance.debt.value !== null && resolved.balance.cash.value !== null
                  ? resolved.balance.debt.value - resolved.balance.cash.value
                  : null,
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h3>Valuation by year</h3>
        <p className="sub">
          Every multiple is struck on today's enterprise value, so a prior-year
          column reads as "what the company trades at against that year's
          results", not what it traded at back then.
        </p>
        <div className="editor-scroll">
          <table className="editor-table">
            <thead>
              <tr>
                <th className="left">Metric</th>
                {years.map((year) => <th key={year}>{year}</th>)}
              </tr>
            </thead>
            <tbody>
              {([
                ['EV/Revenue', 'evRevenue', formatMultiple],
                ['EV/Gross profit', 'evGrossProfit', formatMultiple],
                ['EV/EBITDA', 'evEbitda', formatMultiple],
                ['EV/FCF', 'evFcf', formatMultiple],
                ['P/E', 'pe', formatMultiple],
                ['Revenue growth', 'revenueGrowth', formatPercent],
                ['Gross margin', 'grossMargin', formatPercent],
                ['FCF margin', 'fcfMargin', formatPercent],
                ['Rule of 40', 'ruleOf40', formatPercent],
                ['FCF yield', 'fcfYield', formatPercent],
              ] as const).map(([label, key, format]) => (
                <tr key={key}>
                  <td className="left row-label">{label}</td>
                  {years.map((year) => {
                    const value = metrics.byYear[year]?.[key] ?? null
                    const text = format(value)
                    return (
                      <td key={year} className={`num ${text === 'nm' || text === '—' ? 'nm' : ''}`}>
                        {text}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h3>Inputs</h3>
        <p className="sub">
          Read-only here — edit on the Companies Master tab. The dot marks each
          cell's source; hover a cell to see the FactSet consensus it replaced.
        </p>
        <div className="editor-scroll">
          <table className="editor-table">
            <thead>
              <tr>
                <th className="left">Metric</th>
                {years.map((year) => <th key={year}>{year}</th>)}
              </tr>
            </thead>
            <tbody>
              {METRIC_KEYS.map((metric) => (
                <tr key={metric}>
                  <td className="left row-label">{METRIC_LABELS[metric]}</td>
                  {years.map((year) => {
                    const cell = resolved.series[metric][year]
                    const consensus = tiers.factset?.series?.[metric]?.[year]
                    const displaced =
                      cell?.tier && cell.tier !== 'factset' && typeof consensus === 'number'
                        ? ` · FactSet: ${formatNumber(consensus, 1)}`
                        : ''
                    return (
                      <td
                        key={year}
                        className="num"
                        title={cell?.tier ? `Source: ${cell.tier}${displaced}` : 'No data'}
                      >
                        {cell?.value === null || cell?.value === undefined
                          ? '—'
                          : formatNumber(cell.value, 1)}
                        {cell?.tier && <i className={`tier-dot ${cell.tier}`} title={cell.tier} />}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

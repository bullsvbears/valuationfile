import { useEffect, useMemo, useState } from 'react'
import { LineChart } from './LineChart.js'
import { api, type CompanyDetail as Detail } from './api.js'
import { METRIC_KEYS, type MetricKey } from '../lib/types.js'
import {
  formatCount,
  formatDollars,
  formatMillions,
  formatMultiple,
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

/** KPI display config: label plus how the number reads. */
const KPI_ROWS: { key: string; label: string; kind: 'percent' | 'number' | 'count' | 'dollars' }[] = [
  { key: 'ndrr', label: 'Net dollar retention', kind: 'percent' },
  { key: 'grossRetention', label: 'Gross retention ($)', kind: 'percent' },
  { key: 'subscriptionRevenuePct', label: 'Subscription rev %', kind: 'percent' },
  { key: 'internationalRevenuePct', label: 'International rev %', kind: 'percent' },
  { key: 'sbcPctOfRevenue', label: 'SBC % of revenue', kind: 'percent' },
  { key: 'fcfAdjSbcMargin', label: 'FCF margin adj. for SBC', kind: 'percent' },
  { key: 'cacPaybackMonths', label: 'CAC payback (months)', kind: 'number' },
  { key: 'netIncrementalArrPerCac', label: 'Net incremental ARR / CAC', kind: 'number' },
  { key: 'ltvToCac', label: 'LTV : CAC', kind: 'number' },
  { key: 'avgRevenuePerCustomer', label: 'Avg revenue per customer', kind: 'dollars' },
  { key: 'revenuePerFte', label: 'Revenue per FTE', kind: 'dollars' },
  { key: 'paidCustomers', label: 'Paid customers', kind: 'count' },
  { key: 'ftes', label: 'FTEs', kind: 'count' },
  { key: 'customersOver50k', label: 'Customers >$50K ARR', kind: 'count' },
  { key: 'customersOver100k', label: 'Customers >$100K ARR', kind: 'count' },
  { key: 'customersOver250k', label: 'Customers >$250K ARR', kind: 'count' },
  { key: 'customersOver500k', label: 'Customers >$500K ARR', kind: 'count' },
  { key: 'customersOver1m', label: 'Customers >$1M ARR', kind: 'count' },
]

function formatKpi(value: number, kind: (typeof KPI_ROWS)[number]['kind']): string {
  switch (kind) {
    case 'percent': return `${(value * 100).toFixed(1)}%`
    case 'number': return value.toFixed(1)
    case 'count': return formatCount(value)
    case 'dollars': return formatDollars(value)
  }
}

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

  const kpiYears = useMemo(() => {
    const all = new Set<string>()
    for (const years of Object.values(detail?.kpis ?? {})) {
      for (const y of Object.keys(years)) all.add(y)
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
            <div className="value">{formatCount(resolved.balance.shares.value)}</div>
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
                    const cents = metric === 'eps' // $10.25; everything else $1,250
                    const consensus = tiers.factset?.series?.[metric]?.[year]
                    const displaced =
                      cell?.tier && cell.tier !== 'factset' && typeof consensus === 'number'
                        ? ` · FactSet: ${formatDollars(consensus, cents)}`
                        : ''
                    const negative = typeof cell?.value === 'number' && cell.value < 0
                    return (
                      <td
                        key={year}
                        className={`num ${negative ? 'neg' : ''}`}
                        title={cell?.tier ? `Source: ${cell.tier}${displaced}` : 'No data'}
                      >
                        {formatDollars(cell?.value, cents)}
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

      <HistoryPanel ticker={ticker} years={years} />

      {detail.kpis && Object.keys(detail.kpis).length > 0 && (
        <div className="panel">
          <h3>Operating KPIs</h3>
          <p className="sub">
            Imported from the workbook's KPI columns — net retention, unit
            economics and customer counts. Read-only.
          </p>
          <div className="editor-scroll">
            <table className="editor-table">
              <thead>
                <tr>
                  <th className="left">KPI</th>
                  {kpiYears.map((y) => <th key={y}>{y}</th>)}
                </tr>
              </thead>
              <tbody>
                {KPI_ROWS.filter((row) => detail.kpis?.[row.key]).map((row) => (
                  <tr key={row.key}>
                    <td className="left row-label">{row.label}</td>
                    {kpiYears.map((y) => {
                      const value = detail.kpis?.[row.key]?.[y]
                      const negative = typeof value === 'number' && value < 0
                      return (
                        <td key={y} className={`num ${value === undefined ? 'nm' : ''} ${negative ? 'neg' : ''}`}>
                          {value === undefined ? '—' : formatKpi(value, row.kind)}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * How this name's numbers have moved across the daily snapshots: price, the
 * estimate for a chosen year (live inputs against FactSet consensus, the
 * emphasis form — accent for the live line, gray for the context), and the
 * EV/Revenue multiple.
 */
function HistoryPanel({ ticker, years }: { ticker: string; years: string[] }) {
  const [year, setYear] = useState(years[years.length - 1] ?? '')
  const [points, setPoints] = useState<
    { date: string; price: number | null; resolved: number | null; factset: number | null; evRevenue: number | null }[]
  >([])

  useEffect(() => {
    if (years.length && !years.includes(year)) setYear(years[years.length - 1] as string)
  }, [years, year])

  useEffect(() => {
    if (!year) return
    api
      .historySeries(ticker, 'revenue', year)
      .then((r) => setPoints(r.points))
      .catch(() => setPoints([]))
  }, [ticker, year])

  const accent = 'var(--accent)'
  const context = 'var(--tier-factset)'

  return (
    <div className="panel">
      <div className="controls" style={{ marginBottom: 4 }}>
        <h3 style={{ margin: 0 }}>History</h3>
        <div className="control">
          <label htmlFor="hist-year">Estimate year</label>
          <select id="hist-year" value={year} onChange={(e) => setYear(e.target.value)}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <span className="hint">One point per daily snapshot; history accrues as the app runs.</span>
      </div>
      <div className="chart-row">
        <LineChart
          title="Price"
          series={[{ label: 'Price', color: accent, points: points.map((p) => ({ date: p.date, value: p.price })) }]}
          format={(v) => `$${v.toFixed(2)}`}
        />
        <LineChart
          title={`Revenue estimate · ${year}`}
          series={[
            { label: 'My inputs', color: accent, points: points.map((p) => ({ date: p.date, value: p.resolved })) },
            { label: 'FactSet', color: context, points: points.map((p) => ({ date: p.date, value: p.factset })) },
          ]}
          format={(v) => `$${Math.round(v).toLocaleString('en-US')}`}
        />
        <LineChart
          title={`EV / Revenue · ${year}`}
          series={[{ label: 'EV/Rev', color: accent, points: points.map((p) => ({ date: p.date, value: p.evRevenue })) }]}
          format={(v) => `${v.toFixed(2)}x`}
        />
      </div>
    </div>
  )
}

import { Fragment } from 'react'
import type { GroupSummary } from '../lib/aggregate.js'
import { formatMillions, formatMultiple, formatPercent } from './format.js'

/**
 * Peer-group medians, replacing the Sector Summary sheet. Mean sits beside
 * median because a sector with one 40x outlier reads very differently on each,
 * and the gap between them is itself the signal.
 */

const ROWS = [
  { key: 'evRevenue', label: 'EV/Rev', format: formatMultiple },
  { key: 'evGrossProfit', label: 'EV/GP', format: formatMultiple },
  { key: 'evEbitda', label: 'EV/EBITDA', format: formatMultiple },
  { key: 'evFcf', label: 'EV/FCF', format: formatMultiple },
  { key: 'pe', label: 'P/E', format: formatMultiple },
  { key: 'revenueGrowth', label: 'Rev growth', format: formatPercent },
  { key: 'grossMargin', label: 'Gross margin', format: formatPercent },
  { key: 'fcfMargin', label: 'FCF margin', format: formatPercent },
  { key: 'ruleOf40', label: 'Rule of 40', format: formatPercent },
] as const

export function Summary({
  title,
  summaries,
  year,
  years,
  onYearChange,
}: {
  title: string
  summaries: GroupSummary[]
  year: string
  years: string[]
  onYearChange: (year: string) => void
}) {
  const groups = summaries.filter((s) => s.members.length > 0)

  return (
    <div className="panel">
      <div className="controls" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>{title}</h3>
        <div className="control">
          <label htmlFor="peers-year">Year</label>
          <select
            id="peers-year"
            value={year}
            onChange={(e) => onYearChange(e.target.value)}
          >
            {years.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="table-wrap" style={{ maxHeight: 'none' }}>
        <table>
          <thead>
            <tr>
              <th className="left sticky-col">Group</th>
              <th>N</th>
              <th>Revenue<br />(median)</th>
              {ROWS.map((row) => (
                <th key={row.key} colSpan={2}>{row.label}</th>
              ))}
            </tr>
            <tr>
              <th className="left sticky-col" />
              <th />
              <th />
              {ROWS.map((row) => (
                <Fragment key={row.key}>
                  <th className="group-head">mean</th>
                  <th className="group-head">median</th>
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((summary) => (
              <tr key={summary.group}>
                <td className="left sticky-col">{summary.group}</td>
                <td className="num">{summary.members.length}</td>
                <td className="num">{formatMillions(summary.stats.revenue?.median ?? null)}</td>
                {ROWS.map((row) => {
                  const stat = summary.stats[row.key]
                  return (
                    <Fragment key={row.key}>
                      <td className="num nm">{row.format(stat?.mean ?? null)}</td>
                      <td className="num">{row.format(stat?.median ?? null)}</td>
                    </Fragment>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

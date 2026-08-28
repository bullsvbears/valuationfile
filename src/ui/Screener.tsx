import { useMemo, useState } from 'react'
import type { CompanyView, Dashboard } from '../lib/dashboard.js'
import { isMeaningful, type Multiple } from '../lib/metrics.js'
import type { YearMetrics } from '../lib/metrics.js'
import { formatMillions, formatMultiple, formatPercent, formatPrice, formatReturn } from './format.js'

/**
 * The screener: one row per company, one column per multiple, for a chosen
 * forecast year. This is the view that replaces the Master Software sheet.
 */

type ColumnKind = 'multiple' | 'percent' | 'price' | 'money' | 'return'

interface Column {
  key: string
  label: string
  group: string
  kind: ColumnKind
  /** Pull the sortable/displayable value out of a company row. */
  value: (company: CompanyView, year: YearMetrics | undefined) => Multiple
}

const COLUMNS: Column[] = [
  { key: 'price', label: 'Price', group: 'Market', kind: 'price', value: (c) => c.metrics.price },
  { key: 'ytd', label: 'YTD', group: 'Market', kind: 'return', value: (c) => (c.meta as { ytdReturn?: number | null }).ytdReturn ?? null },
  { key: 'mcap', label: 'Mkt Cap', group: 'Market', kind: 'money', value: (c) => c.metrics.marketCap },
  { key: 'ev', label: 'EV', group: 'Market', kind: 'money', value: (c) => c.metrics.enterpriseValue },

  { key: 'evRevenue', label: 'EV/Rev', group: 'Valuation', kind: 'multiple', value: (_, y) => y?.evRevenue ?? null },
  { key: 'evRevenueGrowth', label: 'EV/Rev/G', group: 'Valuation', kind: 'multiple', value: (_, y) => y?.evRevenueGrowth ?? null },
  { key: 'evRevenueR40', label: 'EV/Rev/R40', group: 'Valuation', kind: 'multiple', value: (_, y) => y?.evRevenueR40 ?? null },
  { key: 'evGrossProfit', label: 'EV/GP', group: 'Valuation', kind: 'multiple', value: (_, y) => y?.evGrossProfit ?? null },
  { key: 'evEbitda', label: 'EV/EBITDA', group: 'Valuation', kind: 'multiple', value: (_, y) => y?.evEbitda ?? null },
  { key: 'evFcf', label: 'EV/FCF', group: 'Valuation', kind: 'multiple', value: (_, y) => y?.evFcf ?? null },
  { key: 'pe', label: 'P/E', group: 'Valuation', kind: 'multiple', value: (_, y) => y?.pe ?? null },
  { key: 'fcfYield', label: 'FCF Yld', group: 'Valuation', kind: 'percent', value: (_, y) => y?.fcfYield ?? null },

  { key: 'revenue', label: 'Revenue', group: 'Fundamentals', kind: 'money', value: (_, y) => y?.revenue ?? null },
  { key: 'revenueGrowth', label: 'Rev Growth', group: 'Fundamentals', kind: 'percent', value: (_, y) => y?.revenueGrowth ?? null },
  { key: 'grossMargin', label: 'GM', group: 'Fundamentals', kind: 'percent', value: (_, y) => y?.grossMargin ?? null },
  { key: 'ebitdaMargin', label: 'EBITDA M', group: 'Fundamentals', kind: 'percent', value: (_, y) => y?.ebitdaMargin ?? null },
  { key: 'fcfMargin', label: 'FCF M', group: 'Fundamentals', kind: 'percent', value: (_, y) => y?.fcfMargin ?? null },
  { key: 'ruleOf40', label: 'Rule of 40', group: 'Fundamentals', kind: 'percent', value: (_, y) => y?.ruleOf40 ?? null },
]

function render(kind: ColumnKind, value: Multiple): string {
  switch (kind) {
    case 'multiple': return formatMultiple(value)
    case 'percent': return formatPercent(value)
    case 'price': return formatPrice(isMeaningful(value) ? value : null)
    case 'money': return formatMillions(isMeaningful(value) ? value : null)
    case 'return': return formatReturn(isMeaningful(value) ? value : null)
  }
}

/** Sort order: meaningful numbers first, then "nm", then missing data. */
function compare(a: Multiple, b: Multiple, direction: 1 | -1): number {
  const rank = (v: Multiple) => (isMeaningful(v) ? 0 : v === null ? 2 : 1)
  const ra = rank(a)
  const rb = rank(b)
  if (ra !== rb) return ra - rb
  if (ra !== 0) return 0
  return ((a as number) - (b as number)) * direction
}

export interface ScreenerProps {
  dashboard: Dashboard
  onSelect: (ticker: string) => void
  year: string
  onYearChange: (year: string) => void
}

export function Screener({ dashboard, onSelect, year, onYearChange }: ScreenerProps) {
  const [search, setSearch] = useState('')
  const [group, setGroup] = useState('All companies')
  const [coverageOnly, setCoverageOnly] = useState(false)
  const [sort, setSort] = useState<{ key: string; direction: 1 | -1 }>({
    key: 'evRevenue',
    direction: -1,
  })

  const groupOptions = useMemo(
    () => [
      'All companies',
      ...dashboard.sectorSummaries.map((s) => s.group),
      ...dashboard.peerSummaries.map((s) => s.group),
    ],
    [dashboard],
  )

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const filtered = dashboard.companies.filter((company) => {
      if (coverageOnly && !company.meta.covered) return false
      if (group !== 'All companies') {
        const inGroup =
          company.meta.sectors.includes(group) || company.meta.peerGroups.includes(group)
        if (!inGroup) return false
      }
      if (!needle) return true
      return (
        company.meta.ticker.toLowerCase().includes(needle) ||
        company.meta.name.toLowerCase().includes(needle)
      )
    })

    const column = COLUMNS.find((c) => c.key === sort.key)
    if (!column) return filtered
    return [...filtered].sort((a, b) =>
      compare(
        column.value(a, a.metrics.byYear[year]),
        column.value(b, b.metrics.byYear[year]),
        sort.direction,
      ),
    )
  }, [dashboard, search, group, coverageOnly, sort, year])

  const toggleSort = (key: string) =>
    setSort((prev) =>
      prev.key === key ? { key, direction: prev.direction === 1 ? -1 : 1 } : { key, direction: -1 },
    )

  const groups = [...new Set(COLUMNS.map((c) => c.group))]

  return (
    <>
      <div className="controls">
        <div className="control">
          <label htmlFor="search">Search</label>
          <input
            id="search"
            type="text"
            value={search}
            placeholder="Ticker or company"
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="control">
          <label htmlFor="group">Group</label>
          <select id="group" value={group} onChange={(e) => setGroup(e.target.value)}>
            {groupOptions.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </div>
        <div className="control">
          <label htmlFor="year">Year</label>
          <select id="year" value={year} onChange={(e) => onYearChange(e.target.value)}>
            {dashboard.years.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
        <div className="control">
          <input
            id="covered"
            type="checkbox"
            checked={coverageOnly}
            onChange={(e) => setCoverageOnly(e.target.checked)}
          />
          <label htmlFor="covered">My coverage only</label>
        </div>
        <span className="count">{rows.length} companies</span>
        <div className="spacer" />
        <div className="legend">
          <span><i className="tier-dot factset" /> FactSet</span>
          <span><i className="tier-dot model" /> My model</span>
          <span><i className="tier-dot override" /> Override</span>
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="left sticky-col group-head" />
              {groups.map((g) => (
                <th
                  key={g}
                  className="group-head"
                  colSpan={COLUMNS.filter((c) => c.group === g).length}
                >
                  {g === 'Market' ? g : `${g} · ${year}`}
                </th>
              ))}
            </tr>
            <tr>
              <th className="left sticky-col" onClick={() => toggleSort('ticker')}>Company</th>
              {COLUMNS.map((column) => (
                <th
                  key={column.key}
                  onClick={() => toggleSort(column.key)}
                  title={`Sort by ${column.label}`}
                >
                  {column.label}
                  {sort.key === column.key ? (sort.direction === -1 ? ' ▾' : ' ▴') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((company) => {
              const yearMetrics = company.metrics.byYear[year]
              return (
                <tr key={company.meta.ticker}>
                  <td className="left sticky-col">
                    <button className="ticker-btn" onClick={() => onSelect(company.meta.ticker)}>
                      {company.meta.ticker}
                    </button>
                    {company.tierCounts.model > 0 && <i className="tier-dot model" title="Own model" />}
                    {company.tierCounts.override > 0 && (
                      <i className="tier-dot override" title="Has manual overrides" />
                    )}
                    <div className="company-name">{company.meta.name}</div>
                  </td>
                  {COLUMNS.map((column) => {
                    const value = column.value(company, yearMetrics)
                    const text = render(column.kind, value)
                    const signed =
                      column.kind === 'return' && isMeaningful(value)
                        ? value > 0 ? 'pos' : value < 0 ? 'neg' : ''
                        : ''
                    return (
                      <td
                        key={column.key}
                        className={`num ${text === 'nm' || text === '—' ? 'nm' : ''} ${signed}`}
                      >
                        {text}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}

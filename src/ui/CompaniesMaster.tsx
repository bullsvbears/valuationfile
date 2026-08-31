import { useEffect, useMemo, useState } from 'react'
import type { Dashboard } from '../lib/dashboard.js'
import type { MetricKey } from '../lib/types.js'
import { api } from './api.js'

/**
 * Companies Master: the one place inputs are edited.
 *
 * Every other tab derives from what this grid resolves, so this is the
 * spreadsheet-shaped view: one row per company, one column per year, one
 * metric at a time. An edit saves to the override tier, which wins over both
 * the FactSet estimate and an own model — that is what makes "everything flows
 * from here" true without discarding the tiers underneath. Clearing a cell
 * removes the override and the value falls back to whatever sits beneath it.
 */

const METRIC_TABS: { key: MetricKey | 'balance'; label: string }[] = [
  { key: 'revenue', label: 'Revenue' },
  { key: 'grossProfit', label: 'Gross profit' },
  { key: 'ebitda', label: 'EBITDA' },
  { key: 'eps', label: 'EPS' },
  { key: 'fcf', label: 'Free cash flow' },
  { key: 'balance', label: 'Price & balance sheet' },
]

const BALANCE_COLUMNS = [
  { key: 'price', label: 'Price ($)' },
  { key: 'shares', label: 'Diluted shares (M)' },
  { key: 'cash', label: 'Cash ($M)' },
  { key: 'debt', label: 'Debt ($M)' },
] as const
type BalanceColumn = (typeof BALANCE_COLUMNS)[number]['key']

/** One pending edit, keyed `ticker|metric|year` (or `ticker|balance|field`). */
type Drafts = Record<string, string>

const draftKey = (ticker: string, metric: string, column: string) =>
  `${ticker}|${metric}|${column}`

/**
 * How a cell renders when it is not being edited.
 *
 * - `dollars0`  $1,250 — money in millions; the underlying value keeps up to
 *               three decimals, the display rounds them away
 * - `dollars2`  $10.25 — per-share figures, where cents are the point
 * - `count`     1,250 — share counts: comma-grouped but not money
 */
type CellFormat = 'dollars0' | 'dollars2' | 'count'

function formatFor(metric: MetricKey | 'balance', column: string): CellFormat {
  if (metric === 'eps') return 'dollars2'
  if (metric !== 'balance') return 'dollars0'
  if (column === 'price') return 'dollars2'
  if (column === 'shares') return 'count'
  return 'dollars0'
}

/** Display form, shown whenever the cell is not focused. */
function formatCell(value: number | null | undefined, format: CellFormat): string {
  if (value === null || value === undefined) return ''
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  switch (format) {
    case 'dollars0':
      return `${sign}$${abs.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    case 'dollars2':
      return `${sign}$${abs.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`
    case 'count':
      return `${sign}${abs.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  }
}

/** Accept what the display shows: dollar signs and commas are not typos. */
function parseCell(raw: string): number | null {
  const trimmed = raw.trim().replace(/[$,]/g, '')
  if (!trimmed) return null
  const value = Number(trimmed)
  // Inputs carry at most three decimals; the display hides them, not more.
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null
}

/** Editing form: the raw number, to three decimals, with nothing hidden. */
function display(value: number | null | undefined): string {
  if (value === null || value === undefined) return ''
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000)
}

export function CompaniesMaster({
  dashboard,
  onSaved,
}: {
  dashboard: Dashboard
  onSaved: () => Promise<void>
}) {
  const [metric, setMetric] = useState<MetricKey | 'balance'>('revenue')
  const [search, setSearch] = useState('')
  const [drafts, setDrafts] = useState<Drafts>({})
  const [focused, setFocused] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * Forecast years added here before any value exists for them.
   *
   * The rest of the app derives its year list from the data, so a new year
   * cascades everywhere the moment the first value is saved: the grid only
   * needs to show the empty column until then. Years the data has since
   * caught up with are dropped so the list never double-counts.
   */
  const [extraYears, setExtraYears] = useState<string[]>([])

  useEffect(() => {
    setExtraYears((prev) => prev.filter((y) => !dashboard.years.includes(y)))
  }, [dashboard.years])

  const years = useMemo(
    () => [...dashboard.years, ...extraYears].sort(),
    [dashboard.years, extraYears],
  )

  const nextYear = String(
    Math.max(...years.map(Number).filter(Number.isFinite), new Date().getFullYear()) + 1,
  )

  const addYear = () => {
    setExtraYears((prev) => (prev.includes(nextYear) ? prev : [...prev, nextYear]))
    if (metric === 'balance') setMetric('revenue')
  }

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return dashboard.companies
      .filter((c) => {
        // Acquired names keep their data (the Acquired Companies comp group
        // still reads it) but their inputs are frozen history, not something
        // to edit here.
        if (c.meta.coverage === 'Acquired Companies') return false
        return (
          !needle ||
          c.meta.ticker.toLowerCase().includes(needle) ||
          c.meta.name.toLowerCase().includes(needle)
        )
      })
      .sort((a, b) => a.meta.ticker.localeCompare(b.meta.ticker))
  }, [dashboard, search])

  const dirtyCount = Object.keys(drafts).length

  const currentValue = (ticker: string, column: string): { value: number | null; tier: string | null } => {
    const company = dashboard.companies.find((c) => c.meta.ticker === ticker)
    if (!company) return { value: null, tier: null }
    if (metric === 'balance') {
      if (column === 'price') return { value: company.metrics.price, tier: company.resolved.price.tier }
      const cell = company.resolved.balance[column as Exclude<BalanceColumn, 'price'>]
      return { value: cell.value, tier: cell.tier }
    }
    const cell = company.resolved.series[metric][column]
    return { value: cell?.value ?? null, tier: cell?.tier ?? null }
  }

  const edit = (ticker: string, column: string, raw: string) => {
    const key = draftKey(ticker, metric, column)
    const original = display(currentValue(ticker, column).value)
    setDrafts((prev) => {
      const next = { ...prev }
      // Typing the original value back is not an edit.
      if (raw === original) delete next[key]
      else next[key] = raw
      return next
    })
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      // Group the pending edits by ticker so each company is one PATCH.
      const byTicker = new Map<string, Drafts>()
      for (const [key, raw] of Object.entries(drafts)) {
        const [ticker] = key.split('|') as [string]
        const entry = byTicker.get(ticker) ?? {}
        entry[key] = raw
        byTicker.set(ticker, entry)
      }

      for (const [ticker, edits] of byTicker) {
        const series: Record<string, Record<string, number | null>> = {}
        const balance: Record<string, number | null> = {}
        let price: number | null | undefined

        for (const [key, raw] of Object.entries(edits)) {
          const [, editMetric, column] = key.split('|') as [string, string, string]
          const value = parseCell(raw)
          // Only an emptied cell clears the override; text that fails to parse
          // is a typo, and a typo must never silently delete a number.
          if (value === null && raw.trim() !== '') continue
          if (editMetric === 'balance') {
            if (column === 'price') price = value
            else balance[column] = value
          } else {
            series[editMetric] ??= {}
            series[editMetric]![column] = value
          }
        }

        await api.saveOverride(ticker, {
          series,
          balance,
          ...(price !== undefined ? { price } : {}),
        })
      }

      setDrafts({})
      await onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const columns: { key: string; label: string }[] =
    metric === 'balance'
      ? BALANCE_COLUMNS.map((c) => ({ key: c.key, label: c.label }))
      : years.map((y) => ({ key: y, label: y }))

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
        <div className="control">
          <label htmlFor="master-search">Search</label>
          <input
            id="master-search"
            type="text"
            value={search}
            placeholder="Ticker or company"
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <span className="count">{rows.length} companies</span>
        <button className="btn" onClick={addYear} title="Add an empty forecast-year column; it flows through the whole app once a value is saved">
          + Add {nextYear}
        </button>
        <div className="spacer" />
        <div className="legend">
          <span><i className="tier-dot factset" /> FactSet</span>
          <span><i className="tier-dot model" /> My model</span>
          <span><i className="tier-dot override" /> Override</span>
        </div>
      </div>

      {error && <div className="status error">{error}</div>}

      <div className="table-wrap master-grid">
        <table className="editor-table">
          <thead>
            <tr>
              <th className="left sticky-col">Company</th>
              {columns.map((column) => (
                <th key={column.key}>{column.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((company) => {
              const ticker = company.meta.ticker
              return (
                <tr key={ticker}>
                  <td className="left sticky-col">
                    <span className="master-ticker">{ticker}</span>
                    <div className="company-name">{company.meta.name}</div>
                  </td>
                  {columns.map((column) => {
                    const key = draftKey(ticker, metric, column.key)
                    const cell = currentValue(ticker, column.key)
                    const format = formatFor(metric, column.key)
                    const raw = key in drafts ? (drafts[key] as string) : display(cell.value)
                    // A focused cell shows the raw number for editing; a
                    // blurred one shows the formatted display, Excel-style.
                    // Unparseable text stays visible as typed so it can be
                    // fixed, rather than blurring away to a blank.
                    const parsed = parseCell(raw)
                    const shown =
                      focused === key || (parsed === null && raw.trim() !== '')
                        ? raw
                        : formatCell(parsed, format)
                    const negative = (parsed ?? 0) < 0
                    return (
                      <td key={column.key}>
                        <input
                          className={[
                            'cell-input',
                            cell.tier ? `tier-${cell.tier}` : '',
                            key in drafts ? 'dirty' : '',
                            negative ? 'neg' : '',
                          ].filter(Boolean).join(' ')}
                          value={shown}
                          placeholder="—"
                          title={cell.tier ? `Source: ${cell.tier}` : 'No data'}
                          onFocus={() => setFocused(key)}
                          onBlur={() => setFocused(null)}
                          onChange={(e) => edit(ticker, column.key, e.target.value)}
                        />
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="actions savebar">
        <button className="btn primary" disabled={!dirtyCount || saving} onClick={() => void save()}>
          {saving
            ? 'Saving…'
            : dirtyCount
              ? `Save ${dirtyCount} change${dirtyCount === 1 ? '' : 's'}`
              : 'No changes'}
        </button>
        <button className="btn" disabled={!dirtyCount || saving} onClick={() => setDrafts({})}>
          Discard
        </button>
        <span className="hint">
          Edits save as overrides, which every other tab follows. Clearing a cell
          falls back to your model or FactSet.
        </span>
      </div>
    </>
  )
}

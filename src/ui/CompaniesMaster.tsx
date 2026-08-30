import { useMemo, useState } from 'react'
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

function parseCell(raw: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const value = Number(trimmed.replace(/,/g, ''))
  return Number.isFinite(value) ? value : null
}

/** Show stored values at full precision only when they carry it. */
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
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const years = dashboard.years

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return dashboard.companies
      .filter(
        (c) =>
          !needle ||
          c.meta.ticker.toLowerCase().includes(needle) ||
          c.meta.name.toLowerCase().includes(needle),
      )
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
                    const value = key in drafts ? (drafts[key] as string) : display(cell.value)
                    return (
                      <td key={column.key}>
                        <input
                          className={[
                            'cell-input',
                            cell.tier ? `tier-${cell.tier}` : '',
                            key in drafts ? 'dirty' : '',
                          ].filter(Boolean).join(' ')}
                          value={value}
                          placeholder="—"
                          title={cell.tier ? `Source: ${cell.tier}` : 'No data'}
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

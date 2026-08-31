import { Fragment, useState } from 'react'
import type { GroupSummary } from '../lib/aggregate.js'
import { api } from './api.js'
import { formatMillions, formatMultiple, formatPercent } from './format.js'

/**
 * Peer-group medians, replacing the Sector Summary sheet. Mean sits beside
 * median because a sector with one 40x outlier reads very differently on each,
 * and the gap between them is itself the signal.
 *
 * Groups are editable in place: expanding a row opens its member list, where
 * tickers can be removed or added (with a new-group form at the bottom of the
 * table). Edits persist to the universe and every stat restrikes immediately,
 * since the roll-ups are computed from the membership on each load.
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
  kind,
  companies,
  onChanged,
}: {
  title: string
  summaries: GroupSummary[]
  year: string
  years: string[]
  onYearChange: (year: string) => void
  /** Which mapping this tab edits. */
  kind: 'sector' | 'financial'
  /** The full universe, for the add-ticker autocomplete. */
  companies: { ticker: string; name: string }[]
  /** Reload after a membership edit so the stats restrike. */
  onChanged: () => Promise<void> | void
}) {
  const groups = summaries.filter((s) => s.members.length > 0)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [addTicker, setAddTicker] = useState('')
  const [newGroup, setNewGroup] = useState('')
  const [newGroupTicker, setNewGroupTicker] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const edit = async (group: string, changes: { add?: string[]; remove?: string[] }) => {
    setBusy(true)
    setError(null)
    try {
      await api.updateGroup(kind, group, changes)
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const totalColumns = 3 + ROWS.length * 2

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
              <Fragment key={summary.group}>
                <tr>
                  <td className="left sticky-col">
                    <button
                      className="group-toggle"
                      onClick={() => {
                        setExpanded(expanded === summary.group ? null : summary.group)
                        setAddTicker('')
                        setError(null)
                      }}
                      title="Edit this group's members"
                    >
                      {expanded === summary.group ? '▾' : '▸'} {summary.group}
                    </button>
                  </td>
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
                {expanded === summary.group && (
                  <tr className="group-editor-row">
                    <td colSpan={totalColumns}>
                      <div className="group-editor">
                        {summary.members.map((ticker) => (
                          <span key={ticker} className="chip">
                            {ticker}
                            <button
                              className="chip-remove"
                              disabled={busy}
                              title={`Remove ${ticker} from ${summary.group}`}
                              onClick={() => void edit(summary.group, { remove: [ticker] })}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                        <form
                          className="chip-add"
                          onSubmit={(e) => {
                            e.preventDefault()
                            if (!addTicker.trim()) return
                            void edit(summary.group, { add: [addTicker] }).then(() =>
                              setAddTicker(''),
                            )
                          }}
                        >
                          <input
                            type="text"
                            list="all-tickers"
                            value={addTicker}
                            placeholder="Add ticker…"
                            disabled={busy}
                            onChange={(e) => setAddTicker(e.target.value)}
                          />
                          <button className="btn" type="submit" disabled={busy || !addTicker.trim()}>
                            Add
                          </button>
                        </form>
                        {error && <span className="asof-error">{error}</span>}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <datalist id="all-tickers">
        {companies.map((c) => (
          <option key={c.ticker} value={c.ticker}>{c.name}</option>
        ))}
      </datalist>

      <form
        className="actions"
        onSubmit={(e) => {
          e.preventDefault()
          const group = newGroup.trim()
          const ticker = newGroupTicker.trim()
          if (!group || !ticker) return
          void edit(group, { add: [ticker] }).then(() => {
            setNewGroup('')
            setNewGroupTicker('')
            setExpanded(group)
          })
        }}
      >
        <input
          type="text"
          className="new-group-input"
          value={newGroup}
          placeholder="New group name"
          disabled={busy}
          onChange={(e) => setNewGroup(e.target.value)}
        />
        <input
          type="text"
          className="new-group-input"
          list="all-tickers"
          value={newGroupTicker}
          placeholder="First ticker"
          disabled={busy}
          onChange={(e) => setNewGroupTicker(e.target.value)}
        />
        <button className="btn" type="submit" disabled={busy || !newGroup.trim() || !newGroupTicker.trim()}>
          Create group
        </button>
        <span className="hint">
          Click a group name to edit its members. Changes restrike every mean and median immediately.
        </span>
      </form>
    </div>
  )
}

import { Fragment, useMemo, useState } from 'react'
import { summariseGroup, type GroupStat } from '../lib/aggregate.js'
import type { Dashboard } from '../lib/dashboard.js'
import type { CompanyMetrics, YearMetrics } from '../lib/metrics.js'
import { api } from './api.js'
import { formatMillions, formatMultiple, formatPercent } from './format.js'

/**
 * Peer-group tables, replacing the Sector Summary sheet.
 *
 * Median leads — the desk's convention, and the statistic a 40x outlier
 * cannot drag — with a toggle to mean. Valuation metrics show the latest two
 * forecast years side by side and fundamentals the latest three, both derived
 * from the data's own year list so a new year flows in on its own.
 *
 * Groups are editable in place: expanding a row opens its member list, where
 * tickers can be removed or added (with a new-group form at the bottom of the
 * table). Edits persist to the universe and every stat restrikes immediately,
 * since the roll-ups are computed from the membership on each load.
 */

type Stat = 'median' | 'mean'

const VALUATION_ROWS = [
  { key: 'evRevenue', label: 'EV/Rev', format: formatMultiple },
  { key: 'evGrossProfit', label: 'EV/GP', format: formatMultiple },
  { key: 'evEbitda', label: 'EV/EBITDA', format: formatMultiple },
  { key: 'evFcf', label: 'EV/FCF', format: formatMultiple },
  { key: 'pe', label: 'P/E', format: formatMultiple },
] as const

const FUNDAMENTAL_ROWS = [
  { key: 'revenue', label: 'Revenue', format: formatMillions },
  { key: 'revenueGrowth', label: 'Rev Growth', format: formatPercent },
  { key: 'grossMargin', label: 'Gross Margin', format: formatPercent },
  { key: 'fcfMargin', label: 'FCF Margin', format: formatPercent },
  { key: 'ruleOf40', label: 'Rule of 40', format: formatPercent },
] as const

type MetricKeyOf = keyof YearMetrics

export function Summary({
  title,
  kind,
  dashboard,
  onChanged,
}: {
  title: string
  /** Which mapping this tab edits. */
  kind: 'sector' | 'financial'
  dashboard: Dashboard
  /** Reload after a membership edit so the stats restrike. */
  onChanged: () => Promise<void> | void
}) {
  const [stat, setStat] = useState<Stat>('median')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [addTicker, setAddTicker] = useState('')
  const [newGroup, setNewGroup] = useState('')
  const [newGroupTicker, setNewGroupTicker] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const valuationYears = useMemo(() => dashboard.years.slice(-2), [dashboard.years])
  const fundamentalYears = useMemo(() => dashboard.years.slice(-3), [dashboard.years])

  const rosters = useMemo(
    () =>
      (kind === 'sector' ? dashboard.sectorSummaries : dashboard.peerSummaries).filter(
        (g) => g.members.length > 0,
      ),
    [dashboard, kind],
  )

  /** group -> year -> the full stat table, computed from live member metrics. */
  const statsByGroup = useMemo(() => {
    const metricsByTicker = new Map<string, CompanyMetrics>(
      dashboard.companies.map((c) => [c.meta.ticker, c.metrics]),
    )
    const allYears = [...new Set([...valuationYears, ...fundamentalYears])]
    const out = new Map<string, Map<string, ReturnType<typeof summariseGroup>>>()
    for (const roster of rosters) {
      const members = roster.members
        .map((t) => metricsByTicker.get(t))
        .filter((m): m is CompanyMetrics => Boolean(m))
      const byYear = new Map<string, ReturnType<typeof summariseGroup>>()
      for (const year of allYears) byYear.set(year, summariseGroup(roster.group, members, year))
      out.set(roster.group, byYear)
    }
    return out
  }, [dashboard, rosters, valuationYears, fundamentalYears])

  const cell = (group: string, year: string, key: MetricKeyOf): number | null => {
    const groupStats = statsByGroup.get(group)?.get(year)?.stats as
      | Partial<Record<string, GroupStat>>
      | undefined
    const entry = groupStats?.[key]
    return (stat === 'median' ? entry?.median : entry?.mean) ?? null
  }

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

  const blocks: { label: string; years: string[]; rows: readonly { key: string; label: string; format: (v: number | null) => string }[] }[] = [
    { label: 'Valuation', years: valuationYears, rows: VALUATION_ROWS },
    { label: 'Fundamentals', years: fundamentalYears, rows: FUNDAMENTAL_ROWS },
  ]

  const totalColumns =
    2 + VALUATION_ROWS.length * valuationYears.length + FUNDAMENTAL_ROWS.length * fundamentalYears.length

  return (
    <div className="panel">
      <div className="controls" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>{title}</h3>
        <nav className="tabs">
          {(['median', 'mean'] as const).map((option) => (
            <button
              key={option}
              className="tab"
              aria-selected={stat === option}
              onClick={() => setStat(option)}
            >
              {option === 'median' ? 'Median' : 'Mean'}
            </button>
          ))}
        </nav>
        <span className="hint">
          Valuation shows the latest two forecast years; fundamentals the latest three.
        </span>
      </div>

      <div className="table-wrap" style={{ maxHeight: 'none' }}>
        <table>
          <thead>
            <tr>
              <th className="left sticky-col group-head" />
              <th className="group-head" />
              {blocks.flatMap((block) =>
                block.rows.map((row) => (
                  <th
                    key={`${block.label}-${row.key}`}
                    className="group-head group-start"
                    colSpan={block.years.length}
                  >
                    {row.label}
                  </th>
                )),
              )}
            </tr>
            <tr>
              <th className="left sticky-col">Group</th>
              <th>N</th>
              {blocks.flatMap((block) =>
                block.rows.flatMap((row) =>
                  block.years.map((year, index) => (
                    <th key={`${row.key}-${year}`} className={index === 0 ? 'group-start' : ''}>
                      {year}
                    </th>
                  )),
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {rosters.map((roster) => (
              <Fragment key={roster.group}>
                <tr>
                  <td className="left sticky-col">
                    <button
                      className="group-toggle"
                      onClick={() => {
                        setExpanded(expanded === roster.group ? null : roster.group)
                        setAddTicker('')
                        setError(null)
                      }}
                      title="Edit this group's members"
                    >
                      {expanded === roster.group ? '▾' : '▸'} {roster.group}
                    </button>
                  </td>
                  <td className="num">{roster.members.length}</td>
                  {blocks.flatMap((block) =>
                    block.rows.flatMap((row) =>
                      block.years.map((year, index) => {
                        const value = cell(roster.group, year, row.key as MetricKeyOf)
                        return (
                          <td
                            key={`${row.key}-${year}`}
                            className={`num ${value === null ? 'nm' : ''} ${index === 0 ? 'group-start' : ''}`}
                          >
                            {row.format(value)}
                          </td>
                        )
                      }),
                    ),
                  )}
                </tr>
                {expanded === roster.group && (
                  <tr className="group-editor-row">
                    <td colSpan={totalColumns}>
                      <div className="group-editor">
                        {roster.members.map((ticker) => (
                          <span key={ticker} className="chip">
                            {ticker}
                            <button
                              className="chip-remove"
                              disabled={busy}
                              title={`Remove ${ticker} from ${roster.group}`}
                              onClick={() => void edit(roster.group, { remove: [ticker] })}
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
                            void edit(roster.group, { add: [addTicker] }).then(() =>
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
        {dashboard.companies.map((c) => (
          <option key={c.meta.ticker} value={c.meta.ticker}>{c.meta.name}</option>
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
          Click a group name to edit its members. Changes restrike every statistic immediately.
        </span>
      </form>
    </div>
  )
}

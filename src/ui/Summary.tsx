import { Fragment, useEffect, useMemo, useState } from 'react'
import { mean, median, summariseGroup, type GroupStat } from '../lib/aggregate.js'
import type { CompanyView, Dashboard } from '../lib/dashboard.js'
import type { CompanyMetrics, YearMetrics } from '../lib/metrics.js'
import { api, type GroupAuditEntry } from './api.js'
import { formatMillions, formatMultiple, formatPercent } from './format.js'

/**
 * Peer-group tables, replacing the Sector Summary sheet.
 *
 * Median leads — the desk's convention, and the statistic a 40x outlier
 * cannot drag — with a toggle to mean. Valuation metrics show the latest two
 * forecast years side by side and fundamentals the latest three, both derived
 * from the data's own year list so a new year flows in on its own. YTD is
 * aggregated with the same statistic as everything else.
 *
 * Expanding a group lists its constituents with the same columns, each
 * removable in place; new members are added on the row beneath. Every
 * membership change lands in the audit log at the bottom of the tab.
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

function ytdCell(value: number | null): { text: string; cls: string } {
  if (value === null) return { text: '—', cls: 'nm' }
  return {
    text: `${value > 0 ? '+' : ''}${(value * 100).toFixed(1)}%`,
    cls: value > 0 ? 'pos' : value < 0 ? 'neg' : '',
  }
}

/** "14:02 · Security Software: +CRWD −OKTA" rows for one mapping's edits. */
function AuditLog({ kind }: { kind: 'sector' | 'financial' }) {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<GroupAuditEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || entries !== null) return
    api
      .groupAudit()
      .then(({ entries: all }) => setEntries(all.filter((e) => e.kind === kind)))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [open, entries, kind])

  return (
    <div className="audit-log">
      <button className="group-toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} Membership audit log
      </button>
      {open && error && <div className="status error">{error}</div>}
      {open && entries !== null && (
        <div className="audit-entries">
          {entries.length === 0 && (
            <span className="hint">No membership changes recorded yet.</span>
          )}
          {entries.slice(0, 100).map((entry, index) => (
            <div key={`${entry.at}-${index}`} className="audit-entry">
              <span className="audit-when">
                {entry.at.slice(0, 10)} {entry.at.slice(11, 16)}
              </span>
              <span className="audit-group">
                {entry.group}
                {entry.created ? ' (created)' : ''}
              </span>
              <span>
                {entry.added.map((t) => (
                  <span key={t} className="audit-add">+{t} </span>
                ))}
                {entry.removed.map((t) => (
                  <span key={t} className="audit-remove">−{t} </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

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

  const companyByTicker = useMemo(
    () => new Map<string, CompanyView>(dashboard.companies.map((c) => [c.meta.ticker, c])),
    [dashboard],
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

  /** Group YTD, aggregated with the same statistic as everything else. */
  const groupYtd = useMemo(() => {
    const out = new Map<string, { median: number | null; mean: number | null }>()
    for (const roster of rosters) {
      const values = roster.members
        .map((t) => companyByTicker.get(t)?.ytdReturn)
        .filter((v): v is number => typeof v === 'number')
      out.set(roster.group, { median: median(values), mean: mean(values) })
    }
    return out
  }, [rosters, companyByTicker])

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
    3 + VALUATION_ROWS.length * valuationYears.length + FUNDAMENTAL_ROWS.length * fundamentalYears.length

  /** The metric cells shared by group rows and constituent rows. */
  const metricCells = (value: (year: string, key: MetricKeyOf) => number | null) =>
    blocks.flatMap((block) =>
      block.rows.flatMap((row) =>
        block.years.map((year, index) => {
          const v = value(year, row.key as MetricKeyOf)
          return (
            <td
              key={`${row.key}-${year}`}
              className={`num ${v === null ? 'nm' : ''} ${index === 0 ? 'group-start' : ''}`}
            >
              {row.format(v)}
            </td>
          )
        }),
      ),
    )

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
          Expand a group for its constituents.
        </span>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="left sticky-col group-head" />
              <th className="group-head" />
              <th className="group-head group-start">Returns</th>
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
              <th className="group-start">YTD</th>
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
            {rosters.map((roster) => {
              const ytd = ytdCell(
                (stat === 'median'
                  ? groupYtd.get(roster.group)?.median
                  : groupYtd.get(roster.group)?.mean) ?? null,
              )
              const isOpen = expanded === roster.group
              return (
                <Fragment key={roster.group}>
                  <tr>
                    <td className="left sticky-col">
                      <button
                        className="group-toggle"
                        onClick={() => {
                          setExpanded(isOpen ? null : roster.group)
                          setAddTicker('')
                          setError(null)
                        }}
                        title="Show this group's constituents"
                      >
                        {isOpen ? '▾' : '▸'} {roster.group}
                      </button>
                    </td>
                    <td className="num">{roster.members.length}</td>
                    <td className={`num group-start ${ytd.cls}`}>{ytd.text}</td>
                    {metricCells((year, key) => cell(roster.group, year, key))}
                  </tr>
                  {isOpen &&
                    roster.members.map((ticker) => {
                      const company = companyByTicker.get(ticker)
                      const memberYtd = ytdCell(company?.ytdReturn ?? null)
                      return (
                        <tr key={`${roster.group}-${ticker}`} className="member-row">
                          <td className="left sticky-col">
                            <span className="member-cell">
                              <button
                                className="chip-remove"
                                disabled={busy}
                                title={`Remove ${ticker} from ${roster.group}`}
                                onClick={() => void edit(roster.group, { remove: [ticker] })}
                              >
                                ×
                              </button>
                              <span className="member-ticker">{ticker}</span>
                              <span className="member-name">{company?.meta.name ?? ''}</span>
                            </span>
                          </td>
                          <td />
                          <td className={`num group-start ${memberYtd.cls}`}>{memberYtd.text}</td>
                          {metricCells((year, key) => {
                            const raw = company?.metrics.byYear[year]?.[key]
                            return typeof raw === 'number' ? raw : null
                          })}
                        </tr>
                      )
                    })}
                  {isOpen && (
                    <tr className="group-editor-row">
                      <td colSpan={totalColumns}>
                        <div className="group-editor">
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
                              placeholder={`Add ticker to ${roster.group}…`}
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
              )
            })}
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
          Click a group name for its constituents. Changes restrike every statistic immediately.
        </span>
      </form>

      <AuditLog kind={kind} />
    </div>
  )
}

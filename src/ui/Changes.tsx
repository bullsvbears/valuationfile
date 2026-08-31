import { Fragment as Fragment2, useEffect, useMemo, useState } from 'react'
import { median } from '../lib/aggregate.js'
import type { Dashboard } from '../lib/dashboard.js'
import { isMeaningful } from '../lib/metrics.js'
import { api, type HistorySnapshot } from './api.js'

/**
 * Changes by comp group: today's group medians against a chosen snapshot
 * date, in the layout of the workbook's Sector Summary "Today / Last Week /
 * % Delta" blocks. One table for sectors, one for financial groups; material
 * single-company moves live on the Summary tab.
 */

interface GroupRow {
  group: string
  n: number
  ytd: number | null
  sinceReturn: number | null
  blocks: Record<string, { today: number | null; then: number | null }>
}

/** The metric blocks across the table, in the workbook's order. */
const BLOCKS = [
  { key: 'evRevenue', label: 'EV/Rev', kind: 'multiple' as const, delta: 'pct' as const },
  { key: 'revenue', label: 'Rev', kind: 'money' as const, delta: 'pct' as const },
  { key: 'revenueGrowth', label: 'Rev Growth', kind: 'percent' as const, delta: 'pts' as const },
  { key: 'evFcf', label: 'EV/FCF', kind: 'multiple' as const, delta: 'pct' as const },
  { key: 'fcfMargin', label: 'FCF Margin', kind: 'percent' as const, delta: 'pts' as const },
  { key: 'ruleOf40', label: 'Rule of 40', kind: 'percent' as const, delta: 'pts' as const },
]

function fmt(value: number | null, kind: 'multiple' | 'money' | 'percent'): string {
  if (value === null) return '—'
  switch (kind) {
    case 'multiple': return `${value.toFixed(1)}x`
    case 'money': return `$${Math.round(value).toLocaleString('en-US')}`
    case 'percent': return `${(value * 100).toFixed(1)}%`
  }
}

function fmtDelta(
  today: number | null,
  then: number | null,
  mode: 'pct' | 'pts',
): { text: string; cls: string } {
  if (today === null || then === null) return { text: '—', cls: 'nm' }
  const delta = mode === 'pct' ? (then === 0 ? null : today / then - 1) : today - then
  if (delta === null) return { text: '—', cls: 'nm' }
  const text = `${delta > 0 ? '+' : ''}${(delta * 100).toFixed(1)}%${mode === 'pts' ? ' pts' : ''}`
  const cls = Math.abs(delta) < 0.0005 ? '' : delta > 0 ? 'pos' : 'neg'
  return { text, cls }
}

function fmtReturn(value: number | null): { text: string; cls: string } {
  if (value === null) return { text: '—', cls: 'nm' }
  return {
    text: `${value > 0 ? '+' : ''}${(value * 100).toFixed(1)}%`,
    cls: value > 0 ? 'pos' : value < 0 ? 'neg' : '',
  }
}

export function Changes({ dashboard }: { dashboard: Dashboard }) {
  const [dates, setDates] = useState<string[] | null>(null)
  const [compareTo, setCompareTo] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<HistorySnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)

  const today = new Date().toISOString().slice(0, 10)
  const year = dashboard.years[dashboard.years.length - 1] ?? ''
  const priorYear = String(Number(year) - 1)

  useEffect(() => {
    api
      .historyDates()
      .then(({ dates: all }) => {
        setDates(all)
        const prior = all.filter((d) => d < today)
        setCompareTo(prior.length ? (prior[prior.length - 1] as string) : null)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!compareTo) return
    setSnapshot(null)
    api
      .historySnapshot(compareTo)
      .then(setSnapshot)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [compareTo])

  const tables = useMemo(() => {
    if (!snapshot) return null

    /** Per-company then-values reconstructed from the snapshot. */
    const thenByTicker = new Map<string, Record<string, number | null> & { price: number | null }>()
    for (const [ticker, past] of Object.entries(snapshot.companies)) {
      const rev = past.series?.revenue?.[year] ?? null
      const revPrior = past.series?.revenue?.[priorYear] ?? null
      const fcf = past.series?.fcf?.[year] ?? null
      const growth = rev !== null && revPrior !== null && revPrior !== 0 ? rev / Math.abs(revPrior) - 1 : null
      const margin = rev !== null && rev !== 0 && fcf !== null ? fcf / rev : null
      thenByTicker.set(ticker, {
        price: past.price ?? null,
        evRevenue: past.multiples?.[year]?.evRevenue ?? null,
        evFcf: past.multiples?.[year]?.evFcf ?? null,
        revenue: rev,
        revenueGrowth: growth,
        fcfMargin: margin,
        ruleOf40: growth !== null && margin !== null ? growth + margin : null,
      })
    }

    const companyByTicker = new Map(dashboard.companies.map((c) => [c.meta.ticker, c]))

    const buildRows = (rosters: { group: string; members: string[] }[]): GroupRow[] =>
      rosters
        .filter((r) => r.members.length > 0)
        .map((roster) => {
          const members = roster.members
            .map((t) => companyByTicker.get(t))
            .filter((c): c is NonNullable<typeof c> => Boolean(c))

          const collectToday = (key: string): number[] =>
            members
              .map((c) => {
                const v = c.metrics.byYear[year]?.[key as 'evRevenue'] ?? null
                return isMeaningful(v) ? v : null
              })
              .filter((v): v is number => v !== null)
          const collectThen = (key: string): number[] =>
            members
              .map((c) => thenByTicker.get(c.meta.ticker)?.[key] ?? null)
              .filter((v): v is number => typeof v === 'number')

          const blocks: GroupRow['blocks'] = {}
          for (const block of BLOCKS) {
            blocks[block.key] = {
              today: median(collectToday(block.key)),
              then: median(collectThen(block.key)),
            }
          }

          const sinceMoves = members
            .map((c) => {
              const priceThen = thenByTicker.get(c.meta.ticker)?.price
              const priceNow = c.metrics.price
              return typeof priceThen === 'number' && priceThen !== 0 && priceNow !== null
                ? priceNow / priceThen - 1
                : null
            })
            .filter((v): v is number => v !== null)

          return {
            group: roster.group,
            n: roster.members.length,
            ytd: median(members.map((c) => c.ytdReturn).filter((v): v is number => v !== null)),
            sinceReturn: median(sinceMoves),
            blocks,
          }
        })

    return {
      sectors: buildRows(dashboard.sectorSummaries),
      financial: buildRows(dashboard.peerSummaries),
    }
  }, [dashboard, snapshot, year, priorYear])

  if (error) return <div className="status error">{error}</div>
  if (dates === null) return <div className="loading">Loading history…</div>

  const priorDates = dates.filter((d) => d < today)
  if (!priorDates.length) {
    return (
      <div className="panel">
        <h3>Changes</h3>
        <p className="sub">
          Nothing to compare yet: today's snapshot is the first one recorded. A
          snapshot is stored automatically each day the dashboard is used — from
          tomorrow, this page shows each comp group's medians today against a
          date you pick, in the Today / Then / Δ layout of the old Sector
          Summary sheet.
        </p>
      </div>
    )
  }

  const renderTable = (label: string, rows: GroupRow[]) => (
    <div className="panel" key={label}>
      <h3>{label}</h3>
      <div className="table-wrap" style={{ maxHeight: 'none' }}>
        <table>
          <thead>
            <tr>
              <th className="left sticky-col group-head" />
              <th className="group-head" />
              <th className="group-head group-start" colSpan={2}>Returns</th>
              {BLOCKS.map((block) => (
                <th key={block.key} className="group-head group-start" colSpan={3}>
                  {year} {block.label}
                </th>
              ))}
            </tr>
            <tr>
              <th className="left sticky-col">Group</th>
              <th>N</th>
              <th className="group-start">YTD</th>
              <th>Since {compareTo}</th>
              {BLOCKS.map((block) => (
                <Fragment2 key={block.key}>
                  <th className="group-start">Today</th>
                  <th>{compareTo}</th>
                  <th>{block.delta === 'pts' ? 'Δ pts' : '%Δ'}</th>
                </Fragment2>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const ytd = fmtReturn(row.ytd)
              const since = fmtReturn(row.sinceReturn)
              return (
                <tr key={row.group}>
                  <td className="left sticky-col">{row.group}</td>
                  <td className="num">{row.n}</td>
                  <td className={`num group-start ${ytd.cls}`}>{ytd.text}</td>
                  <td className={`num ${since.cls}`}>{since.text}</td>
                  {BLOCKS.map((block) => {
                    const value = row.blocks[block.key] ?? { today: null, then: null }
                    const delta = fmtDelta(value.today, value.then, block.delta)
                    return (
                      <Fragment2 key={block.key}>
                        <td className="num group-start">{fmt(value.today, block.kind)}</td>
                        <td className="num nm">{fmt(value.then, block.kind)}</td>
                        <td className={`num ${delta.cls}`}>{delta.text}</td>
                      </Fragment2>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )

  return (
    <>
      <div className="controls">
        <div className="control">
          <label htmlFor="chg-date">Compare to</label>
          <select
            id="chg-date"
            value={compareTo ?? ''}
            onChange={(e) => setCompareTo(e.target.value)}
          >
            {priorDates.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </div>
        <span className="hint">
          Group medians, {year} data. Material single-company moves are on the Summary tab.
        </span>
      </div>
      {tables && renderTable('Sector groups', tables.sectors)}
      {tables && renderTable('Financial groups', tables.financial)}
    </>
  )
}

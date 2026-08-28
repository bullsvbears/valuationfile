import { Fragment, useEffect, useMemo, useState } from 'react'
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
 * Company page: the resolved view on top, then an editable input grid.
 *
 * Editing writes to whichever tier the analyst is working in. For a covered
 * name that is their own model; for anything else it is a manual override on
 * top of FactSet. Both are shown side by side with the FactSet number they
 * replace, so an edit is never made blind to the consensus it departs from.
 */

const METRIC_LABELS: Record<MetricKey, string> = {
  revenue: 'Revenue',
  grossProfit: 'Gross profit',
  ebitda: 'EBITDA',
  fcf: 'Free cash flow',
  eps: 'EPS',
}

type EditTarget = 'model' | 'override'
type Draft = Record<string, string>

const cellId = (metric: string, year: string) => `${metric}:${year}`

function parseCell(raw: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const value = Number(trimmed.replace(/,/g, ''))
  return Number.isFinite(value) ? value : null
}

export function CompanyDetail({ ticker, onBack }: { ticker: string; onBack: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [target, setTarget] = useState<EditTarget>('override')
  const [draft, setDraft] = useState<Draft>({})
  const [saving, setSaving] = useState(false)

  const load = async () => {
    setError(null)
    try {
      const next = await api.company(ticker)
      setDetail(next)
      setDraft({})
      // Default to editing the model for a name the analyst covers.
      setTarget(next.meta.covered ? 'model' : 'override')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const dirty = Object.keys(draft).length > 0

  /** True when this override cell was carried in from the workbook import. */
  const isImported = (metric: MetricKey, year: string): boolean =>
    Boolean(tiers.override?.imported?.[metric]?.includes(year))

  const analystOverrides = Object.entries(tiers.override?.series ?? {}).reduce(
    (total, [metric, years]) =>
      total +
      Object.keys(years ?? {}).filter((year) => !isImported(metric as MetricKey, year)).length,
    0,
  )

  /** The value currently stored in the tier being edited, as a string. */
  const storedValue = (metric: MetricKey, year: string): string => {
    const facts = target === 'model' ? tiers.model : tiers.override
    const value = facts?.series?.[metric]?.[year]
    return typeof value === 'number' ? String(value) : ''
  }

  const cellValue = (metric: MetricKey, year: string): string => {
    const id = cellId(metric, year)
    return id in draft ? (draft[id] as string) : storedValue(metric, year)
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const series: Record<string, Record<string, number | null>> = {}
      for (const [id, raw] of Object.entries(draft)) {
        const [metric, year] = id.split(':') as [MetricKey, string]
        series[metric] ??= {}
        series[metric]![year] = parseCell(raw)
      }

      if (target === 'model') {
        // A model is stored whole, so merge the draft onto what is already there.
        const merged: Record<string, Record<string, number | null>> = {}
        for (const metric of METRIC_KEYS) {
          const existing: Record<string, number | null> = {}
          for (const [year, value] of Object.entries(tiers.model?.series?.[metric] ?? {})) {
            if (value !== undefined) existing[year] = value
          }
          merged[metric] = existing
        }
        for (const [metric, entries] of Object.entries(series)) {
          for (const [year, value] of Object.entries(entries)) {
            if (value === null) delete merged[metric]![year]
            else merged[metric]![year] = value
          }
        }
        await api.saveModel(ticker, {
          ...(tiers.model ?? {}),
          ticker,
          series: merged,
          balance: tiers.model?.balance,
        })
      } else {
        await api.saveOverride(ticker, { series })
      }
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const clearOverrides = async () => {
    setSaving(true)
    try {
      await api.clearOverrides(ticker)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="detail">
      <div className="panel">
        <div className="controls" style={{ marginBottom: 10 }}>
          <button className="back" onClick={onBack}>← All companies</button>
          <div className="spacer" />
          {meta.covered && <span className="badge covered">Covered · {meta.coverage}</span>}
          {tiers.model && <span className="badge model">Own model</span>}
          {analystOverrides > 0 && (
            <span className="badge override">
              {analystOverrides} override{analystOverrides === 1 ? '' : 's'}
            </span>
          )}
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
        <div className="controls">
          <div className="control">
            <label htmlFor="target">Editing</label>
            <select
              id="target"
              value={target}
              onChange={(e) => { setTarget(e.target.value as EditTarget); setDraft({}) }}
            >
              <option value="model">My model</option>
              <option value="override">Manual override</option>
            </select>
          </div>
          <span className="hint">
            {target === 'model'
              ? 'Your model supplies the years you fill in; the rest fall back to FactSet.'
              : 'An override wins over both your model and FactSet. Clear a cell to fall back.'}
          </span>
        </div>

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
                <Fragment key={metric}>
                  <tr>
                    <td className="left row-label">{METRIC_LABELS[metric]}</td>
                    {years.map((year) => {
                      const cell = resolved.series[metric][year]
                      return (
                        <td key={year} className="num">
                          {cell?.value === null || cell?.value === undefined
                            ? '—'
                            : formatNumber(cell.value, 1)}
                          {cell?.tier && <i className={`tier-dot ${cell.tier}`} title={cell.tier} />}
                        </td>
                      )
                    })}
                  </tr>
                  <tr>
                    <td className="left hint">
                      {target === 'model' ? 'my model' : 'override'}
                    </td>
                    {years.map((year) => {
                      const id = cellId(metric, year)
                      const factsetValue = tiers.factset?.series?.[metric]?.[year]
                      return (
                        <td key={year}>
                          <input
                            className={[
                              'cell-input',
                              `tier-${target}`,
                              id in draft ? 'dirty' : '',
                              target === 'override' && isImported(metric, year) ? 'imported' : '',
                            ].filter(Boolean).join(' ')}
                            value={cellValue(metric, year)}
                            placeholder={
                              typeof factsetValue === 'number'
                                ? formatNumber(factsetValue, 1)
                                : '—'
                            }
                            title={[
                              typeof factsetValue === 'number'
                                ? `FactSet: ${factsetValue}`
                                : 'No FactSet estimate',
                              target === 'override' && isImported(metric, year)
                                ? tiers.override?.importNote ?? 'Imported from the workbook'
                                : '',
                            ].filter(Boolean).join(' · ')}
                            onChange={(e) =>
                              setDraft((prev) => ({ ...prev, [id]: e.target.value }))
                            }
                          />
                        </td>
                      )
                    })}
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>

        <div className="actions">
          <button className="btn primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? 'Saving…' : `Save ${Object.keys(draft).length || ''} change${Object.keys(draft).length === 1 ? '' : 's'}`.trim()}
          </button>
          <button className="btn" disabled={!dirty || saving} onClick={() => setDraft({})}>
            Discard
          </button>
          {analystOverrides > 0 && (
            <button className="btn" disabled={saving} onClick={() => void clearOverrides()}>
              Clear my {analystOverrides} override{analystOverrides === 1 ? '' : 's'}
            </button>
          )}
          <span className="hint">
            Placeholder shows the FactSet estimate the cell replaces. Reported actuals
            imported from the workbook are kept when you clear overrides.
          </span>
        </div>
      </div>
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { summariseGroup } from '../lib/aggregate.js'
import type { CompanyView, Dashboard } from '../lib/dashboard.js'
import { isMeaningful, type YearMetrics } from '../lib/metrics.js'
import { formatMultiple, formatPercent, formatPrice } from './format.js'

/**
 * Company Snapshot: one name against its peer group, in the 3×3 chart layout
 * of the desk's valuation-snapshot slide — a valuation multiple, the margin
 * or growth behind it, and the growth-adjusted view, for EV/Revenue, EBITDA
 * and FCF. Latest two forecast years, grouped bars, company vs group median.
 *
 * Every axis starts at zero and the top scales to the data (a negative value
 * extends the axis below zero rather than clipping — the baseline stays at 0).
 */

const CHARTS: { key: keyof YearMetrics; title: string; kind: 'multiple' | 'percent' }[] = [
  { key: 'evRevenue', title: 'EV/Revenue', kind: 'multiple' },
  { key: 'revenueGrowth', title: 'Revenue Growth', kind: 'percent' },
  { key: 'evRevenueR40', title: 'EV/Revenue/Rule of 40', kind: 'multiple' },
  { key: 'evEbitda', title: 'EV/EBITDA', kind: 'multiple' },
  { key: 'ebitdaMargin', title: 'EBITDA Margin', kind: 'percent' },
  { key: 'ebitdaGrowth', title: 'EBITDA Growth', kind: 'percent' },
  { key: 'evFcf', title: 'EV/FCF', kind: 'multiple' },
  { key: 'fcfMargin', title: 'FCF Margin', kind: 'percent' },
  { key: 'fcfGrowth', title: 'FCF Growth', kind: 'percent' },
]

function fmt(kind: 'multiple' | 'percent', value: number): string {
  return kind === 'multiple' ? formatMultiple(value) : formatPercent(value, 0)
}

/** A clean tick step (1/2/2.5/5 × 10^k) at least `raw` big. */
function niceStep(raw: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  for (const s of [1, 2, 2.5, 5, 10]) {
    if (s * magnitude >= raw) return s * magnitude
  }
  return magnitude * 10
}

/**
 * Axis limits and ticks: from zero to a rounded top just past the data, in
 * clean steps — 0/4/8/12 rather than 0/3.8/7.5/11.3. A negative value pulls
 * the bottom below zero on the same step grid; the baseline stays at 0.
 */
export function niceScale(max: number, min: number): { top: number; bottom: number; ticks: number[] } {
  const span = Math.max(max, 0) - Math.min(min, 0)
  if (span === 0) return { top: 1, bottom: 0, ticks: [0, 0.25, 0.5, 0.75, 1] }
  const step = niceStep((span * 1.1) / 4)
  const top = max > 0 ? Math.ceil((max * 1.05) / step) * step : 0
  const bottom = min < 0 ? Math.floor((min * 1.05) / step) * step : 0
  const ticks: number[] = []
  for (let tick = bottom; tick <= top + step / 2; tick += step) ticks.push(tick)
  return { top, bottom, ticks }
}

interface ChartGroup {
  label: string
  /** [company, median] — null renders as a labeled gap, never a zero bar. */
  values: (number | null)[]
}

/**
 * A grouped bar chart: clusters on the x-axis (years), two series per
 * cluster. Value labels ride above each bar in text ink; identity comes from
 * the legend below plus the fill.
 */
function BarChart({
  title,
  groups,
  seriesLabels,
  kind,
}: {
  title: string
  groups: ChartGroup[]
  seriesLabels: [string, string]
  kind: 'multiple' | 'percent'
}) {
  const width = 340
  const height = 240
  const margin = { top: 28, right: 8, bottom: 22, left: 46 }
  const plotW = width - margin.left - margin.right
  const plotH = height - margin.top - margin.bottom

  const values = groups.flatMap((g) => g.values).filter((v): v is number => v !== null)
  const hasData = values.length > 0
  const { top, bottom, ticks } = hasData
    ? niceScale(Math.max(...values), Math.min(...values))
    : { top: 1, bottom: 0, ticks: [] as number[] }
  const span = top - bottom || 1
  const y = (v: number) => margin.top + ((top - v) / span) * plotH

  const clusterW = plotW / Math.max(groups.length, 1)
  const barW = Math.min(46, (clusterW - 24) / 2)

  return (
    <div className="snap-chart">
      <h4>{title}</h4>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              className="snap-grid"
              x1={margin.left}
              x2={width - margin.right}
              y1={y(tick)}
              y2={y(tick)}
            />
            <text className="snap-tick" x={margin.left - 6} y={y(tick) + 3.5} textAnchor="end">
              {hasData ? fmt(kind, tick) : ''}
            </text>
          </g>
        ))}
        {groups.map((group, gi) => {
          const cx = margin.left + clusterW * gi + clusterW / 2
          return (
            <g key={group.label}>
              {group.values.map((value, si) => {
                const x = cx - barW - 1 + si * (barW + 2)
                if (value === null) {
                  return (
                    <text key={si} className="snap-null" x={x + barW / 2} y={y(0) - 6} textAnchor="middle">
                      —
                    </text>
                  )
                }
                const y0 = y(Math.max(0, value))
                const h = Math.abs(y(value) - y(0))
                return (
                  <g key={si}>
                    <rect
                      className={si === 0 ? 'snap-bar-a' : 'snap-bar-b'}
                      x={x}
                      y={y0}
                      width={barW}
                      height={Math.max(h, 1)}
                      rx={2}
                    >
                      <title>{`${seriesLabels[si] ?? ''} · ${group.label}: ${fmt(kind, value)}`}</title>
                    </rect>
                    <text
                      className="snap-value"
                      x={x + barW / 2}
                      y={(value >= 0 ? y0 : y0 + h) + (value >= 0 ? -5 : 12)}
                      textAnchor="middle"
                    >
                      {fmt(kind, value)}
                    </text>
                  </g>
                )
              })}
              <text className="snap-tick" x={cx} y={height - 6} textAnchor="middle">
                {group.label}
              </text>
            </g>
          )
        })}
        {/* Baseline drawn over the bars so a zero axis reads crisply. */}
        <line
          className="snap-axis"
          x1={margin.left}
          x2={width - margin.right}
          y1={y(0)}
          y2={y(0)}
        />
        {!hasData && (
          <text className="snap-null" x={width / 2} y={height / 2} textAnchor="middle">
            no data
          </text>
        )}
      </svg>
    </div>
  )
}

/** Chart-drawing constants shared with the capture below. */
const CHART_W = 340
const CHART_H = 240

/**
 * Serialize one chart's SVG with its styles inlined, so it renders
 * identically outside the page's stylesheets, and load it as an image.
 */
function svgToImage(svg: SVGSVGElement): Promise<HTMLImageElement> {
  const clone = svg.cloneNode(true) as SVGSVGElement
  const originals = svg.querySelectorAll<SVGElement>('*')
  const copies = clone.querySelectorAll<SVGElement>('*')
  const KEEP = ['fill', 'stroke', 'stroke-width', 'font-size', 'font-family', 'font-weight'] as const
  originals.forEach((node, index) => {
    const computed = getComputedStyle(node)
    const copy = copies[index]
    if (!copy) return
    for (const property of KEEP) {
      copy.style.setProperty(property, computed.getPropertyValue(property))
    }
  })
  clone.setAttribute('width', String(CHART_W))
  clone.setAttribute('height', String(CHART_H))
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')

  const blob = new Blob([new XMLSerializer().serializeToString(clone)], {
    type: 'image/svg+xml;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => { URL.revokeObjectURL(url); resolve(image) }
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Chart render failed')) }
    image.src = url
  })
}

/**
 * Rasterise the whole snapshot — title line, legend, all nine charts — onto
 * one canvas at 2x, so the paste into a document is crisp at print size.
 */
async function renderSnapshotPng(
  root: HTMLElement,
  title: string,
  seriesLabels: [string, string],
): Promise<HTMLCanvasElement> {
  const charts = [...root.querySelectorAll<HTMLElement>('.snap-chart')]
  const images = await Promise.all(
    charts.map((chart) => {
      const svg = chart.querySelector('svg')
      if (!svg) throw new Error('Chart render failed')
      return svgToImage(svg)
    }),
  )
  const titles = charts.map((c) => c.querySelector('h4')?.textContent ?? '')

  const rootStyle = getComputedStyle(document.documentElement)
  const colorA = rootStyle.getPropertyValue('--snap-a').trim() || '#2f54a8'
  const colorB = rootStyle.getPropertyValue('--snap-b').trim() || '#3ba7de'
  const ink = rootStyle.getPropertyValue('--text').trim() || '#14171d'
  const border = rootStyle.getPropertyValue('--border').trim() || '#e6e9ef'
  const surface = rootStyle.getPropertyValue('--surface').trim() || '#ffffff'

  const scale = 2
  const pad = 14
  const chartTitleH = 26
  const cols = 3
  const rows = Math.ceil(images.length / cols)
  const cellW = CHART_W + pad * 2
  const cellH = CHART_H + chartTitleH + pad
  const headerH = 76
  const width = cols * cellW + pad * 2
  const height = headerH + rows * cellH + pad

  const canvas = document.createElement('canvas')
  canvas.width = width * scale
  canvas.height = height * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')
  ctx.scale(scale, scale)

  ctx.fillStyle = surface
  ctx.fillRect(0, 0, width, height)

  // Title line with the reference slide's underline rule, then the legend.
  ctx.fillStyle = ink
  ctx.font = '700 20px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText(title, width / 2, 30)
  ctx.strokeStyle = colorB
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(pad * 2, 42)
  ctx.lineTo(width - pad * 2, 42)
  ctx.stroke()

  ctx.font = '600 13px system-ui, sans-serif'
  const legendWidths = seriesLabels.map((label) => ctx.measureText(label).width + 20)
  const legendGap = 26
  let x = width / 2 - (legendWidths[0]! + legendWidths[1]! + legendGap) / 2
  seriesLabels.forEach((label, index) => {
    ctx.fillStyle = index === 0 ? colorA : colorB
    ctx.fillRect(x, 54, 12, 12)
    ctx.fillStyle = ink
    ctx.textAlign = 'left'
    ctx.fillText(label, x + 18, 64)
    x += legendWidths[index]! + legendGap
  })

  images.forEach((image, index) => {
    const col = index % cols
    const row = Math.floor(index / cols)
    const cellX = pad + col * cellW
    const cellY = headerH + row * cellH

    ctx.strokeStyle = border
    ctx.lineWidth = 1
    ctx.strokeRect(cellX + 0.5, cellY + 0.5, cellW - pad, cellH - pad)

    ctx.fillStyle = ink
    ctx.font = '700 14px system-ui, sans-serif'
    ctx.textAlign = 'center'
    const titleX = cellX + (cellW - pad) / 2
    ctx.fillText(titles[index] ?? '', titleX, cellY + 18)
    const half = ctx.measureText(titles[index] ?? '').width / 2
    ctx.strokeStyle = ink
    ctx.beginPath()
    ctx.moveTo(titleX - half, cellY + 21)
    ctx.lineTo(titleX + half, cellY + 21)
    ctx.stroke()

    ctx.drawImage(image, cellX + (cellW - pad - CHART_W) / 2, cellY + chartTitleH, CHART_W, CHART_H)
  })

  return canvas
}

export function Snapshot({ dashboard }: { dashboard: Dashboard }) {
  const companies = useMemo(
    () =>
      dashboard.companies
        .filter((c) => c.meta.coverage !== 'Acquired Companies')
        .sort((a, b) => a.meta.ticker.localeCompare(b.meta.ticker)),
    [dashboard],
  )
  const byTicker = useMemo(
    () => new Map<string, CompanyView>(companies.map((c) => [c.meta.ticker, c])),
    [companies],
  )

  const groupOptions = useMemo(
    () => ({
      sector: dashboard.sectorSummaries.filter((g) => g.members.length > 0).map((g) => g.group),
      financial: dashboard.peerSummaries.filter((g) => g.members.length > 0).map((g) => g.group),
    }),
    [dashboard],
  )

  const [ticker, setTicker] = useState<string>(
    () => companies.find((c) => c.meta.covered)?.meta.ticker ?? companies[0]?.meta.ticker ?? '',
  )
  const company = byTicker.get(ticker)

  /** The company's own groups lead the default; financial groups first. */
  const defaultGroup = (view: CompanyView | undefined): string =>
    view?.meta.peerGroups[0] ?? view?.meta.sectors[0] ?? groupOptions.financial[0] ?? ''
  const [group, setGroup] = useState<string>(() => defaultGroup(company))

  // Switching company keeps the group when it still applies, else follows.
  useEffect(() => {
    const view = byTicker.get(ticker)
    if (!view) return
    const belongs = view.meta.peerGroups.includes(group) || view.meta.sectors.includes(group)
    if (!belongs) setGroup(defaultGroup(view))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker])

  const years = useMemo(() => dashboard.years.slice(-2), [dashboard.years])

  const members = useMemo(() => {
    const roster =
      dashboard.sectorSummaries.find((g) => g.group === group) ??
      dashboard.peerSummaries.find((g) => g.group === group)
    return (roster?.members ?? [])
      .map((t) => byTicker.get(t) ?? dashboard.companies.find((c) => c.meta.ticker === t))
      .filter((c): c is CompanyView => Boolean(c))
  }, [dashboard, group, byTicker])

  const medianStats = useMemo(() => {
    const metrics = members.map((c) => c.metrics)
    return new Map(years.map((year) => [year, summariseGroup(group, metrics, year).stats]))
  }, [members, years, group])

  const gridRef = useRef<HTMLDivElement>(null)
  const [captureNote, setCaptureNote] = useState<{ text: string; error: boolean } | null>(null)
  const [capturing, setCapturing] = useState(false)

  const copyCharts = async () => {
    const view = byTicker.get(ticker)
    if (!gridRef.current || !view) return
    setCapturing(true)
    setCaptureNote(null)
    try {
      const canvas = await renderSnapshotPng(
        gridRef.current,
        `${ticker}: ${view.meta.name} — Stock Price: ${formatPrice(view.metrics.price)}`,
        [ticker, `${group} Median`],
      )
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('Could not render the image')

      // Clipboard first; a blocked clipboard falls back to a PNG download,
      // which inserts into a document just as well.
      if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
          setCaptureNote({ text: 'Copied — paste straight into your doc.', error: false })
          return
        } catch {
          // fall through to the download
        }
      }
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `${ticker}-snapshot.png`
      link.click()
      URL.revokeObjectURL(link.href)
      setCaptureNote({
        text: 'Clipboard blocked by the browser — downloaded a PNG instead.',
        error: false,
      })
    } catch (e) {
      setCaptureNote({ text: e instanceof Error ? e.message : String(e), error: true })
    } finally {
      setCapturing(false)
    }
  }

  if (!company) return <div className="panel">No companies yet.</div>

  const seriesLabels: [string, string] = [ticker, `${group} Median`]

  const chartGroups = (key: keyof YearMetrics): ChartGroup[] =>
    years.map((year) => {
      const own = company.metrics.byYear[year]?.[key]
      const med = (medianStats.get(year)?.[key as 'evRevenue'] ?? undefined)?.median ?? null
      return {
        label: year,
        values: [
          isMeaningful(own as number | null) ? (own as number) : null,
          isMeaningful(med) ? med : null,
        ],
      }
    })

  return (
    <div className="panel">
      <div className="controls" style={{ marginBottom: 4 }}>
        <div className="control">
          <label htmlFor="snap-company">Company</label>
          <select id="snap-company" value={ticker} onChange={(e) => setTicker(e.target.value)}>
            {companies.map((c) => (
              <option key={c.meta.ticker} value={c.meta.ticker}>
                {c.meta.ticker} — {c.meta.name}
              </option>
            ))}
          </select>
        </div>
        <div className="control">
          <label htmlFor="snap-group">Peer group</label>
          <select id="snap-group" value={group} onChange={(e) => setGroup(e.target.value)}>
            <optgroup label="Financial groups">
              {groupOptions.financial.map((g) => (
                <option key={`f-${g}`} value={g}>{g}</option>
              ))}
            </optgroup>
            <optgroup label="Sector groups">
              {groupOptions.sector.map((g) => (
                <option key={`s-${g}`} value={g}>{g}</option>
              ))}
            </optgroup>
          </select>
        </div>
        <button
          className="btn"
          onClick={() => void copyCharts()}
          disabled={capturing}
          title="Render the title, legend and all nine charts into one image on the clipboard, ready to paste into Word"
        >
          {capturing ? 'Capturing…' : 'Copy charts'}
        </button>
        {captureNote ? (
          <span className={captureNote.error ? 'asof-error' : 'hint'}>{captureNote.text}</span>
        ) : (
          <span className="hint">
            Group medians include every member with data, as on the peers tabs.
          </span>
        )}
      </div>

      <h3 className="snap-title">
        {ticker}: {company.meta.name} — Stock Price: {formatPrice(company.metrics.price)}
      </h3>

      <div className="snap-legend">
        <span><i className="snap-dot a" /> {seriesLabels[0]}</span>
        <span><i className="snap-dot b" /> {seriesLabels[1]}</span>
      </div>

      <div className="snap-grid-3" ref={gridRef}>
        {CHARTS.map((chart) => (
          <BarChart
            key={chart.key}
            title={chart.title}
            kind={chart.kind}
            groups={chartGroups(chart.key)}
            seriesLabels={seriesLabels}
          />
        ))}
      </div>
    </div>
  )
}

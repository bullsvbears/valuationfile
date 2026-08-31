import { useMemo, useRef, useState } from 'react'

/**
 * A small time-series line chart: 2px lines, hairline gridlines, a legend for
 * two or more series, and a crosshair-with-tooltip hover layer. Colors follow
 * the emphasis form — the live series in the accent hue, context series in the
 * de-emphasis gray — with the legend carrying identity, never color alone.
 */

export interface ChartSeries {
  label: string
  /** CSS color for the line; identity is carried by the legend, not the hue. */
  color: string
  points: { date: string; value: number | null }[]
}

const WIDTH = 460
const HEIGHT = 180
const PAD = { top: 12, right: 14, bottom: 22, left: 52 }

export function LineChart({
  title,
  series,
  format,
}: {
  title: string
  series: ChartSeries[]
  format: (value: number) => string
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null)

  const { dates, scaleX, scaleY, ticks, drawable } = useMemo(() => {
    const dates = [...new Set(series.flatMap((s) => s.points.map((p) => p.date)))].sort()
    const values = series.flatMap((s) =>
      s.points.map((p) => p.value).filter((v): v is number => v !== null),
    )
    const drawable = dates.length >= 2 && values.length >= 2
    let lo = Math.min(...values)
    let hi = Math.max(...values)
    if (!Number.isFinite(lo)) { lo = 0; hi = 1 }
    if (lo === hi) { lo -= Math.abs(lo) * 0.05 || 1; hi += Math.abs(hi) * 0.05 || 1 }
    const pad = (hi - lo) * 0.08
    lo -= pad
    hi += pad

    const plotW = WIDTH - PAD.left - PAD.right
    const plotH = HEIGHT - PAD.top - PAD.bottom
    const scaleX = (date: string) =>
      PAD.left + (dates.indexOf(date) / Math.max(dates.length - 1, 1)) * plotW
    const scaleY = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * plotH

    const ticks = [lo + (hi - lo) * 0.08, (lo + hi) / 2, hi - (hi - lo) * 0.08]
    return { dates, scaleX, scaleY, ticks, drawable }
  }, [series])

  if (!drawable) {
    return (
      <div className="chart">
        <h4>{title}</h4>
        <p className="hint">Charts appear once two or more daily snapshots exist.</p>
      </div>
    )
  }

  const byDate = (s: ChartSeries) => new Map(s.points.map((p) => [p.date, p.value]))
  const maps = series.map(byDate)
  const hoverDate = hover !== null ? dates[hover] : null

  const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * WIDTH
    const plotW = WIDTH - PAD.left - PAD.right
    const index = Math.round(((x - PAD.left) / plotW) * (dates.length - 1))
    setHover(Math.max(0, Math.min(dates.length - 1, index)))
  }

  return (
    <div className="chart" ref={wrapRef}>
      <h4>{title}</h4>
      {series.length > 1 && (
        <div className="chart-legend">
          {series.map((s) => (
            <span key={s.label}>
              <i className="legend-swatch" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={title}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={WIDTH - PAD.right}
              y1={scaleY(t)}
              y2={scaleY(t)}
              className="chart-grid"
            />
            <text x={PAD.left - 6} y={scaleY(t) + 3} className="chart-tick" textAnchor="end">
              {format(t)}
            </text>
          </g>
        ))}
        <text x={PAD.left} y={HEIGHT - 6} className="chart-tick">{dates[0]}</text>
        <text x={WIDTH - PAD.right} y={HEIGHT - 6} className="chart-tick" textAnchor="end">
          {dates[dates.length - 1]}
        </text>

        {hoverDate && (
          <line
            x1={scaleX(hoverDate)}
            x2={scaleX(hoverDate)}
            y1={PAD.top}
            y2={HEIGHT - PAD.bottom}
            className="chart-crosshair"
          />
        )}

        {series.map((s, si) => {
          const path = dates
            .map((d) => {
              const v = maps[si]!.get(d)
              return v === null || v === undefined ? null : `${scaleX(d)},${scaleY(v)}`
            })
            .filter(Boolean)
          if (path.length < 2) return null
          const last = s.points.filter((p) => p.value !== null).at(-1)
          return (
            <g key={s.label}>
              <polyline
                points={path.join(' ')}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {last && (
                // End marker with a surface ring so it survives line crossings.
                <circle
                  cx={scaleX(last.date)}
                  cy={scaleY(last.value as number)}
                  r={4}
                  fill={s.color}
                  className="chart-end-dot"
                />
              )}
            </g>
          )
        })}
      </svg>
      {hoverDate && (
        <div className="chart-tooltip">
          <strong>{hoverDate}</strong>
          {series.map((s, si) => {
            const v = maps[si]!.get(hoverDate)
            return (
              <span key={s.label}>
                <i className="legend-swatch" style={{ background: s.color }} />
                {s.label}: {v === null || v === undefined ? '—' : format(v)}
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}

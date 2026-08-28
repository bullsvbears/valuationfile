import { useCallback, useEffect, useState } from 'react'
import { api } from './api.js'
import type { Dashboard } from '../lib/dashboard.js'
import { Screener } from './Screener.js'
import { CompanyDetail } from './CompanyDetail.js'
import { Summary } from './Summary.js'

type View = 'screener' | 'sectors' | 'peers'

export function App() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<View>('screener')
  const [selected, setSelected] = useState<string | null>(null)
  const [year, setYear] = useState<string | null>(null)

  const load = useCallback(async (forYear?: string) => {
    try {
      const next = await api.dashboard(forYear)
      setDashboard(next)
      setYear((current) => current ?? next.summaryYear)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // Reloading on year change keeps the peer summaries struck on the same year
  // the screener is showing.
  useEffect(() => {
    if (year) void load(year)
  }, [year, load])

  if (error) return <div className="status error">{error}</div>
  if (!dashboard || !year) return <div className="loading">Loading valuation data…</div>

  return (
    <div className="app">
      <header className="topbar">
        <h1>Valuation Dashboard</h1>
        {!selected && (
          <nav className="tabs">
            {([
              ['screener', 'Screener'],
              ['sectors', 'Sectors'],
              ['peers', 'Peer groups'],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                className="tab"
                aria-selected={view === key}
                onClick={() => setView(key)}
              >
                {label}
              </button>
            ))}
          </nav>
        )}
        <div className="spacer" />
        <span className="asof">
          {dashboard.asOf
            ? `FactSet as of ${new Date(dashboard.asOf).toLocaleString()}`
            : dashboard.factsetSource}
        </span>
      </header>

      <main className="content">
        {selected ? (
          <CompanyDetail
            ticker={selected}
            onBack={() => { setSelected(null); void load(year) }}
          />
        ) : view === 'screener' ? (
          <Screener
            dashboard={dashboard}
            onSelect={setSelected}
            year={year}
            onYearChange={setYear}
          />
        ) : view === 'sectors' ? (
          <Summary title="Sectors" summaries={dashboard.sectorSummaries} year={year} />
        ) : (
          <Summary title="Peer groups" summaries={dashboard.peerSummaries} year={year} />
        )}
      </main>
    </div>
  )
}

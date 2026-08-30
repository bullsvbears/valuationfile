import { useCallback, useEffect, useState } from 'react'
import { api, NotSignedInError, type SessionState } from './api.js'
import { Login } from './Login.js'
import type { Dashboard } from '../lib/dashboard.js'
import { Screener } from './Screener.js'
import { CompanyDetail } from './CompanyDetail.js'
import { Summary } from './Summary.js'
import { CompaniesMaster } from './CompaniesMaster.js'
import { Changes } from './Changes.js'

type View = 'master' | 'screener' | 'changes' | 'sectors' | 'peers'

export function App() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<View>('master')
  const [selected, setSelected] = useState<string | null>(null)
  const [year, setYear] = useState<string | null>(null)
  const [session, setSession] = useState<SessionState | null>(null)

  const load = useCallback(async (forYear?: string) => {
    try {
      const next = await api.dashboard(forYear)
      setDashboard(next)
      setYear((current) => current ?? next.summaryYear)
      setError(null)
    } catch (e) {
      // A session can lapse mid-use, so fall back to the login screen rather
      // than showing the user an error they cannot act on.
      if (e instanceof NotSignedInError) setSession({ authRequired: true, signedIn: false })
      else setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const checkSession = useCallback(async () => {
    try {
      setSession(await api.session())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => { void checkSession() }, [checkSession])

  useEffect(() => {
    if (session?.signedIn) void load()
  }, [session?.signedIn, load])

  // Reloading on year change keeps the peer summaries struck on the same year
  // the screener is showing.
  useEffect(() => {
    if (year && session?.signedIn) void load(year)
  }, [year, session?.signedIn, load])

  const signOut = async () => {
    await api.logout().catch(() => undefined)
    setDashboard(null)
    setYear(null)
    await checkSession()
  }

  if (!session) return <div className="loading">…</div>
  if (!session.signedIn) return <Login onSignedIn={() => void checkSession()} />
  if (error) return <div className="status error">{error}</div>
  if (!dashboard || !year) return <div className="loading">Loading valuation data…</div>

  return (
    <div className="app">
      <header className="topbar">
        <h1>Valuation Dashboard</h1>
        {!selected && (
          <nav className="tabs">
            {([
              ['master', 'Master Input'],
              ['screener', 'Screen'],
              ['changes', 'Changes'],
              ['sectors', 'Sector Peers'],
              ['peers', 'Financial Peers'],
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
        {session.authRequired && (
          <button className="back" onClick={() => void signOut()}>Sign out</button>
        )}
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
        ) : view === 'master' ? (
          <CompaniesMaster dashboard={dashboard} onSaved={() => load(year)} />
        ) : view === 'changes' ? (
          <Changes dashboard={dashboard} />
        ) : view === 'sectors' ? (
          <Summary title="Sector Peers" summaries={dashboard.sectorSummaries} year={year} />
        ) : (
          <Summary title="Financial Peers" summaries={dashboard.peerSummaries} year={year} />
        )}
      </main>
    </div>
  )
}

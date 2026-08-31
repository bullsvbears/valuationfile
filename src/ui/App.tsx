import { useCallback, useEffect, useState } from 'react'
import { api, NotSignedInError, type SessionState } from './api.js'
import { Login } from './Login.js'
import type { Dashboard } from '../lib/dashboard.js'
import { Screener } from './Screener.js'
import { CompanyDetail } from './CompanyDetail.js'
import { Summary } from './Summary.js'
import { CompaniesMaster } from './CompaniesMaster.js'
import { Changes } from './Changes.js'
import { Overview } from './Overview.js'
import { formatAge } from './format.js'

type View = 'summary' | 'master' | 'screener' | 'sectors' | 'peers' | 'changes'

export function App() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<View>('screener')
  const [selected, setSelected] = useState<string | null>(null)
  const [year, setYear] = useState<string | null>(null)
  const [session, setSession] = useState<SessionState | null>(null)
  const [refreshBusy, setRefreshBusy] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)

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

  // While the server is pulling FactSet (the daily refresh or a manual one),
  // poll so the new numbers appear without a hand reload.
  useEffect(() => {
    if (!dashboard?.factsetRefreshing) return
    const timer = setTimeout(() => void load(year ?? undefined), 5000)
    return () => clearTimeout(timer)
  }, [dashboard, year, load])

  const [refreshNote, setRefreshNote] = useState<string | null>(null)

  /** Shared wrapper: one spinner and one message slot for either button. */
  const runRefresh = async (action: () => Promise<string | null>) => {
    setRefreshBusy(true)
    setRefreshError(null)
    setRefreshNote(null)
    try {
      setRefreshNote(await action())
      await load(year ?? undefined)
    } catch (e) {
      setRefreshError(e instanceof Error ? e.message : String(e))
    } finally {
      setRefreshBusy(false)
    }
  }

  const updatePrices = () =>
    runRefresh(async () => {
      const result = await api.refreshPrices()
      const misses = result.unpriced.length + result.unmapped.length
      const source = result.source === 'factset' ? 'FactSet' : 'Polygon EOD'
      return (
        `${result.updated} prices updated (${source})` +
        (result.yearEndCloses ? ` · ${result.yearEndCloses} YTD baselines` : '') +
        (misses ? ` · ${misses} not priced` : '')
      )
    })

  const updateEstimates = () =>
    runRefresh(async () => {
      const result = await api.refresh()
      return `Estimates refreshed for ${result.companies} companies (FactSet)`
    })

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
              ['summary', 'Summary'],
              ['master', 'Master Input'],
              ['screener', 'Screen'],
              ['sectors', 'Sector Peers'],
              ['peers', 'Financial Peers'],
              ['changes', 'Changes'],
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
        <span className={`asof ${refreshError ? 'asof-error' : ''}`}>
          {refreshError
            ? refreshError
            : refreshNote
              ? refreshNote
              : dashboard.factsetRefreshing || refreshBusy
                ? 'Refreshing data…'
                : dashboard.asOf
                  ? `FactSet as of ${formatAge(dashboard.asOf)}`
                  : dashboard.pricesAsOf
                    ? `Prices as of ${formatAge(dashboard.pricesAsOf)} · estimates from workbook import`
                    : dashboard.factsetSource}
        </span>
        <button
          className="back"
          onClick={() => void updatePrices()}
          disabled={refreshBusy || Boolean(dashboard.factsetRefreshing)}
          title="Update stock prices only — FactSet when configured, otherwise free end-of-day closes. Estimates are untouched."
        >
          {refreshBusy || dashboard.factsetRefreshing ? 'Refreshing…' : 'Update prices'}
        </button>
        <button
          className="back"
          onClick={() => void updateEstimates()}
          disabled={refreshBusy || Boolean(dashboard.factsetRefreshing)}
          title="Pull consensus estimates, prices and balance sheet data from FactSet. Requires FactSet credentials; your models and overrides are untouched."
        >
          Update estimates
        </button>
        <a
          className="back"
          href="/api/export.xlsx"
          download
          title="Download every tab as one Excel workbook — Summary, the Master Input grids, Screen, both peers tabs with constituents, and Changes"
        >
          Excel
        </a>
        <a
          className="back"
          href="/api/export"
          download
          title="Download the whole data set — models, overrides, FactSet cache and history — as one JSON file"
        >
          Backup
        </a>
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
        ) : view === 'summary' ? (
          <Overview dashboard={dashboard} />
        ) : view === 'master' ? (
          <CompaniesMaster dashboard={dashboard} onSaved={() => load(year)} />
        ) : view === 'changes' ? (
          <Changes dashboard={dashboard} />
        ) : view === 'sectors' ? (
          <Summary title="Sector Peers" kind="sector" dashboard={dashboard} onChanged={() => load(year)} />
        ) : (
          <Summary title="Financial Peers" kind="financial" dashboard={dashboard} onChanged={() => load(year)} />
        )}
      </main>
    </div>
  )
}

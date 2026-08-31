import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

import { DataStore } from '../src/lib/store.js'
import { assertProductionAuth, authConfigFromEnv, createAuth } from './auth.js'
import { seedDataDir } from './seed.js'
import { ensureDailySnapshot, listSnapshots, readSnapshot, todayKey } from './history.js'
import { backupConfigFromEnv, runBackup, scrubSecrets } from './backup.js'
import { fetchStooqPrices, fetchYearEndCloses } from '../src/prices/stooq.js'
import { buildDashboard, type DashboardInputs } from '../src/lib/dashboard.js'
import { credentialsFromEnv, fetchFactSet } from '../src/factset/client.js'
import type { OverrideEntry, OwnModel } from '../src/lib/types.js'
import type { SavedView } from '../src/lib/store.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const bundledData = path.join(root, 'data')
const dataDir = process.env.DATA_DIR ?? bundledData
const store = new DataStore(dataDir)
const port = Number(process.env.PORT ?? 8787)

const authConfig = authConfigFromEnv()
if (process.env.ALLOW_OPEN_ACCESS !== 'true') assertProductionAuth(authConfig)
const auth = createAuth(authConfig)

const app = express()
// Behind Fly's proxy the client address arrives in X-Forwarded-For; without
// this the login rate limiter would see every request as one address.
app.set('trust proxy', true)
app.use(express.json({ limit: '4mb' }))

app.get('/api/session', auth.session)
app.post('/api/login', auth.login)
app.post('/api/logout', auth.logout)

// Everything below requires a session when a password is configured.
app.use('/api', auth.requireSession)

async function loadInputs(): Promise<DashboardInputs> {
  const [universe, factset, overrides, models] = await Promise.all([
    store.loadUniverse(),
    store.loadFactSet(),
    store.loadOverrides(),
    store.loadModels(),
  ])
  return { universe, factset, overrides, models }
}

/** Wrap a handler so a rejected promise becomes a 500 rather than an unhandled rejection. */
function route(handler: express.RequestHandler): express.RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next)
  }
}

/** Read the `:ticker` path parameter, normalised to the upper-case form used as a key. */
function tickerParam(req: express.Request): string {
  const raw = req.params.ticker
  return String(Array.isArray(raw) ? raw[0] : (raw ?? '')).toUpperCase()
}

const historyDir = () => path.join(dataDir, 'history')

/**
 * One FactSet refresh at a time. The flag rides on the dashboard payload so
 * the UI can show a refreshing state and poll for completion.
 */
const refreshState = { running: false }

class RefreshError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

/**
 * Price-only update from the free Stooq EOD feed: refreshes closes for every
 * live (non-acquired) name, leaving estimates untouched. The report calls out
 * anything it could not price, so a delisting or rename never keeps a stale
 * number standing silently.
 */
async function runPriceUpdate(): Promise<{
  updated: number
  unmapped: string[]
  unpriced: string[]
  yearEndCloses: number
}> {
  const universe = await store.loadUniverse()
  const tickers = universe.companies
    .filter((c) => c.coverage !== 'Acquired Companies')
    .map((c) => c.ticker)
  const result = await fetchStooqPrices(tickers, {
    baseUrl: process.env.STOOQ_BASE_URL,
  })
  const updated = await store.updatePrices(result.prices)

  // Year-to-date returns divide by last year's final close. Fetch those once
  // per calendar year, and only for names that do not already have one: the
  // history endpoint takes a symbol per request, so this is the slow part and
  // must not repeat daily.
  const priorYear = new Date().getFullYear() - 1
  const cache = await store.loadFactSet()
  const missing = tickers.filter(
    (t) =>
      cache.priorYearCloseYear !== priorYear ||
      typeof cache.companies[t]?.priorYearClose !== 'number',
  )

  let yearEndCloses = 0
  if (missing.length) {
    const closes = await fetchYearEndCloses(missing, priorYear, {
      historyUrl: process.env.STOOQ_HISTORY_URL,
    })
    yearEndCloses = await store.updatePriorYearCloses(closes, priorYear)
  }

  return {
    updated,
    unmapped: result.unmapped,
    unpriced: result.unpriced,
    yearEndCloses,
  }
}

async function runFactSetRefresh(): Promise<{ asOf: string; companies: number }> {
  const creds = credentialsFromEnv()
  if (!creds) {
    throw new RefreshError(
      'FactSet credentials not configured. Set FACTSET_USERNAME_SERIAL and FACTSET_API_KEY.',
      503,
    )
  }
  if (refreshState.running) throw new RefreshError('A FactSet refresh is already running.', 409)
  refreshState.running = true
  try {
    const universe = await store.loadUniverse()
    const currentYear = new Date().getFullYear()
    const years = Array.from({ length: 11 }, (_, i) => currentYear - 8 + i)
    const cache = await fetchFactSet(
      creds,
      universe.companies.map((c) => ({ ticker: c.ticker, fiscalYearEnd: c.fiscalYearEnd })),
      { years },
    )
    await store.saveFactSet(cache)
    return { asOf: cache.asOf, companies: Object.keys(cache.companies).length }
  } finally {
    refreshState.running = false
  }
}

/**
 * The once-a-day housekeeping, kicked by the first dashboard request of the
 * day and run in the background so that request is not held for the pull:
 * refresh FactSet first (when credentials exist), then record the snapshot.
 * The order is the point — the day's baseline should carry this morning's
 * consensus, so day-over-day diffs on the Summary tab are real revisions. A
 * failed refresh still snapshots, so change tracking never silently stops.
 */
const dailyTask = { done: '', running: false }

function kickDailyTask(): void {
  const today = todayKey()
  if (dailyTask.done === today || dailyTask.running) return
  if (existsSync(path.join(historyDir(), `${today}.json`))) {
    dailyTask.done = today
    return
  }
  dailyTask.running = true
  void (async () => {
    try {
      let factsetFresh = false
      if (credentialsFromEnv()) {
        try {
          await runFactSetRefresh()
          factsetFresh = true
        } catch (error) {
          console.error(
            'Daily FactSet refresh failed:',
            error instanceof Error ? error.message : error,
          )
        }
      }
      // A FactSet pull already carried live prices; otherwise take the free
      // EOD closes so at least the market side of the day's snapshot is real.
      if (!factsetFresh) {
        try {
          const report = await runPriceUpdate()
          console.log(
            `Daily price update: ${report.updated} priced, ` +
              `${report.unpriced.length} unpriced, ${report.unmapped.length} unmapped` +
              (report.yearEndCloses ? `, ${report.yearEndCloses} year-end closes` : ''),
          )
          if (report.unpriced.length) {
            console.log(`Unpriced tickers: ${report.unpriced.join(', ')}`)
          }
        } catch (error) {
          console.error(
            'Daily price update failed:',
            error instanceof Error ? error.message : error,
          )
        }
      }
      const inputs = await loadInputs()
      await ensureDailySnapshot(historyDir(), buildDashboard(inputs), today)
      dailyTask.done = today

      // With the day's snapshot on disk, push the whole data directory to the
      // backup branch. Failure is logged, never fatal: a broken backup must
      // not take the dashboard down with it.
      const backupConfig = backupConfigFromEnv()
      if (backupConfig) {
        try {
          const outcome = await runBackup(dataDir, backupConfig)
          console.log(`Daily backup: ${outcome}`)
        } catch (error) {
          console.error(
            'Daily backup failed:',
            scrubSecrets(error instanceof Error ? error.message : String(error), backupConfig.remote),
          )
        }
      }
    } catch (error) {
      console.error('Daily snapshot failed:', error)
    } finally {
      dailyTask.running = false
    }
  })()
}

app.get('/api/dashboard', route(async (req, res) => {
  kickDailyTask()
  const inputs = await loadInputs()
  const year = typeof req.query.year === 'string' ? req.query.year : undefined
  res.json({ ...buildDashboard(inputs, year), factsetRefreshing: refreshState.running })
}))

/** Dates for which a snapshot exists, oldest first. */
app.get('/api/history', route(async (_req, res) => {
  res.json({ dates: await listSnapshots(historyDir()) })
}))

/**
 * Time series for one ticker across every stored snapshot: price, the
 * resolved and vendor values for one metric+year, and EV/Revenue. Snapshot
 * files are read on demand; with one file per day this stays cheap for
 * years.
 */
app.get('/api/history/series', route(async (req, res) => {
  const ticker = String(req.query.ticker ?? '').toUpperCase()
  const metric = String(req.query.metric ?? 'revenue')
  const year = String(req.query.year ?? '')
  if (!ticker || !year) {
    res.status(400).json({ error: 'ticker and year are required' })
    return
  }

  const dates = await listSnapshots(historyDir())
  const points = []
  for (const date of dates) {
    const snapshot = await readSnapshot(historyDir(), date)
    const company = snapshot?.companies[ticker]
    if (!company) continue
    points.push({
      date,
      price: company.price,
      resolved: company.series?.[metric as 'revenue']?.[year] ?? null,
      factset: company.factset?.series?.[metric as 'revenue']?.[year] ?? null,
      evRevenue: company.multiples?.[year]?.evRevenue ?? null,
    })
  }
  res.json({ ticker, metric, year, points })
}))

app.get('/api/history/:date', route(async (req, res) => {
  const raw = req.params.date
  const snapshot = await readSnapshot(historyDir(), String(Array.isArray(raw) ? raw[0] : raw))
  if (!snapshot) {
    res.status(404).json({ error: 'No snapshot for that date' })
    return
  }
  res.json(snapshot)
}))

app.get('/api/company/:ticker', route(async (req, res) => {
  const ticker = tickerParam(req)
  const inputs = await loadInputs()
  const dashboard = buildDashboard(inputs)
  const company = dashboard.companies.find((c) => c.meta.ticker === ticker)
  if (!company) {
    res.status(404).json({ error: `Unknown ticker ${ticker}` })
    return
  }
  const kpis = await store.loadKpis()
  res.json({
    ...company,
    kpis: kpis[ticker] ?? null,
    tiers: {
      factset: inputs.factset.companies[ticker] ?? null,
      model: inputs.models[ticker] ?? null,
      override: inputs.overrides.companies[ticker] ?? null,
    },
  })
}))

/** Apply a manual override. A null value in the patch clears that cell. */
app.patch('/api/company/:ticker/override', route(async (req, res) => {
  const ticker = tickerParam(req)
  const entry = await store.patchOverride(ticker, req.body as OverrideEntry)
  res.json(entry)
}))

/**
 * Clear overrides for a company. By default this keeps the cells imported from
 * the source workbook, which are reported actuals rather than analyst edits;
 * `?includeImported=true` clears those as well.
 */
app.delete('/api/company/:ticker/override', route(async (req, res) => {
  await store.clearOverrides(tickerParam(req), req.query.includeImported === 'true')
  res.json({ ok: true })
}))

/** Replace a covered company's own model. */
app.put('/api/company/:ticker/model', route(async (req, res) => {
  const ticker = tickerParam(req)
  const model = { ...(req.body as OwnModel), ticker }
  await store.saveModel(model)
  res.json(model)
}))

/** Saved screener views. */
app.get('/api/views', route(async (_req, res) => {
  res.json(await store.loadViews())
}))

app.put('/api/views', route(async (req, res) => {
  const view = req.body as SavedView
  if (typeof view?.name !== 'string' || !view.name.trim() || view.name.length > 60) {
    res.status(400).json({ error: 'A view needs a name (up to 60 characters)' })
    return
  }
  res.json({ views: await store.saveView({ ...view, name: view.name.trim() }) })
}))

app.delete('/api/views/:name', route(async (req, res) => {
  const raw = req.params.name
  res.json({ views: await store.deleteView(String(Array.isArray(raw) ? raw[0] : raw)) })
}))

/**
 * The whole data directory as one JSON bundle, for a hand-download backup.
 * The git-branch backup is the durable path; this is the "I want a copy on
 * my machine right now" path.
 */
app.get('/api/export', route(async (_req, res) => {
  const [universe, factset, overrides, models, kpis, views] = await Promise.all([
    store.loadUniverse(),
    store.loadFactSet(),
    store.loadOverrides(),
    store.loadModels(),
    store.loadKpis(),
    store.loadViews(),
  ])
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="valuation-backup-${todayKey()}.json"`,
  )
  res.json({ exportedAt: new Date().toISOString(), universe, factset, overrides, models, kpis, views })
}))

/** Edit a comp group's membership: add and/or remove tickers. */
app.patch('/api/groups', route(async (req, res) => {
  const body = req.body as {
    kind?: unknown
    group?: unknown
    add?: unknown
    remove?: unknown
  }
  const kind = body.kind
  const group = body.group
  const tickers = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : []

  if ((kind !== 'sector' && kind !== 'financial') || typeof group !== 'string' || !group.trim()) {
    res.status(400).json({ error: 'Expected kind ("sector" | "financial") and a group name' })
    return
  }

  try {
    const members = await store.updateGroup(kind, group.trim(), {
      add: tickers(body.add),
      remove: tickers(body.remove),
    })
    res.json({ ok: true, group: group.trim(), members })
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
  }
}))

/**
 * Pull fresh data from FactSet into the factset tier, on demand. Overrides
 * and own models are stored separately and are untouched by a refresh.
 */
app.post('/api/refresh', route(async (_req, res) => {
  try {
    if (credentialsFromEnv()) {
      const result = await runFactSetRefresh()
      res.json({ ok: true, mode: 'factset', ...result })
      return
    }
    // No FactSet credentials: fall back to the free EOD price feed rather
    // than refusing, and say plainly what was and was not updated.
    const report = await runPriceUpdate()
    res.json({
      ok: true,
      mode: 'prices',
      ...report,
      note:
        'Prices updated from the free EOD feed. Estimates still need FactSet ' +
        'credentials (FACTSET_USERNAME_SERIAL and FACTSET_API_KEY).',
    })
  } catch (error) {
    if (error instanceof RefreshError) {
      res.status(error.status).json({ error: error.message })
      return
    }
    throw error
  }
}))

/**
 * Serve the built UI when it exists. In development Vite serves it instead and
 * proxies /api here, so an absent build is normal rather than an error - but
 * say so, since `npm start` without a build otherwise just 404s the page.
 */
const dist = path.join(root, 'dist')
const hasBuild = existsSync(path.join(dist, 'index.html'))
if (hasBuild) {
  app.use(express.static(dist))
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')))
}

app.use(((err, _req, res, _next) => {
  console.error(err)
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
}) as express.ErrorRequestHandler)

async function start(): Promise<void> {
  const seeded = await seedDataDir(dataDir, bundledData)
  if (seeded === 'seeded') console.log(`Seeded ${dataDir} from the bundled workbook import.`)

  app.listen(port, () => {
    if (!auth.enabled) {
      console.log('WARNING: no DASHBOARD_PASSWORD_HASH set - the app is unprotected.')
    }
    if (hasBuild) {
      console.log(`Valuation dashboard on http://localhost:${port}`)
    } else {
      console.log(`Valuation dashboard API on http://localhost:${port}`)
      console.log('No UI build found. Run `npm run dev` for development, or')
      console.log('`npm run build` first to serve the UI from this process.')
    }
  })
}

start().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

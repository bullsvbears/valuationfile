import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

import { DataStore } from '../src/lib/store.js'
import { assertProductionAuth, authConfigFromEnv, createAuth } from './auth.js'
import { seedDataDir } from './seed.js'
import { ensureDailySnapshot, listSnapshots, readSnapshot, todayKey } from './history.js'
import { buildDashboard, type DashboardInputs } from '../src/lib/dashboard.js'
import { credentialsFromEnv, fetchFactSet } from '../src/factset/client.js'
import type { OverrideEntry, OwnModel } from '../src/lib/types.js'

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
      if (credentialsFromEnv()) {
        try {
          await runFactSetRefresh()
        } catch (error) {
          console.error(
            'Daily FactSet refresh failed:',
            error instanceof Error ? error.message : error,
          )
        }
      }
      const inputs = await loadInputs()
      await ensureDailySnapshot(historyDir(), buildDashboard(inputs), today)
      dailyTask.done = today
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
  res.json({
    ...company,
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
    const result = await runFactSetRefresh()
    res.json({ ok: true, ...result })
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

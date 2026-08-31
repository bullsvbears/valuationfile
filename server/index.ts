import express from 'express'
import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

import { DataStore } from '../src/lib/store.js'
import { assertProductionAuth, authConfigFromEnv, createAuth } from './auth.js'
import { seedDataDir } from './seed.js'
import { ensureDailySnapshot, listSnapshots, readSnapshot, todayKey } from './history.js'
import { backupConfigFromEnv, runBackup, scrubSecrets } from './backup.js'
import { buildExportWorkbook } from './export-xlsx.js'
import type { MoverSnapshot } from '../src/lib/movers.js'
import {
  fetchPolygonPrices,
  fetchYearEndCloses,
  polygonApiKeyFromEnv,
} from '../src/prices/polygon.js'
import { buildDashboard, type DashboardInputs } from '../src/lib/dashboard.js'
import { credentialsFromEnv, fetchFactSet, fetchFactSetPrices } from '../src/factset/client.js'
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
 * Price-only update from Polygon.io's free tier: refreshes closes for
 * every live (non-acquired) name, leaving estimates untouched. The report
 * calls out anything it could not price, so a delisting or rename never
 * keeps a stale number standing silently.
 */
async function liveTickers(): Promise<string[]> {
  const universe = await store.loadUniverse()
  return universe.companies
    .filter((c) => c.coverage !== 'Acquired Companies')
    .map((c) => c.ticker)
}

/**
 * Year-to-date returns divide by last year's final close. Fetch those once
 * per calendar year, and only for names that do not already have one: the
 * history endpoint takes a symbol per request, so this is the slow part and
 * must not repeat daily. Runs after either price source, since neither the
 * FactSet price pull nor the quote endpoint carries the baseline.
 */
/** Hand-supplied baselines shipped with the image, keyed by year then ticker. */
async function bundledYearEndCloses(year: number): Promise<Record<string, number>> {
  try {
    const raw = await readFile(path.join(bundledData, 'year-end-closes.json'), 'utf8')
    const byYear = JSON.parse(raw) as Record<string, Record<string, number>>
    return byYear[String(year)] ?? {}
  } catch {
    return {}
  }
}

async function ensureYearEndCloses(tickers: string[]): Promise<number> {
  const priorYear = new Date().getFullYear() - 1
  const cache = await store.loadFactSet()
  const stored = (t: string): number | undefined =>
    cache.priorYearCloseYear === priorYear
      ? (cache.companies[t]?.priorYearClose ?? undefined)
      : undefined

  // The analyst's bundled year-end list is authoritative over the free feed:
  // apply it wherever the stored baseline is absent or disagrees, so a volume
  // stamped with feed values before the file shipped still picks it up. A
  // hand-entered close lives on the override tier and beats both regardless.
  const bundled = await bundledYearEndCloses(priorYear)
  const closes: Record<string, number> = {}
  for (const ticker of tickers) {
    const close = bundled[ticker]
    if (typeof close === 'number' && close > 0 && close !== stored(ticker)) {
      closes[ticker] = close
    }
  }

  // Polygon fills what the file leaves open — when a key is configured, and
  // only once per calendar year.
  const stillMissing = tickers.filter(
    (t) =>
      !(t in closes) &&
      !(typeof bundled[t] === 'number' && bundled[t]! > 0) &&
      typeof stored(t) !== 'number',
  )
  const apiKey = polygonApiKeyFromEnv()
  if (stillMissing.length && apiKey) {
    Object.assign(
      closes,
      await fetchYearEndCloses(stillMissing, priorYear, {
        apiKey,
        baseUrl: process.env.POLYGON_BASE_URL,
      }),
    )
  }
  if (!Object.keys(closes).length && cache.priorYearCloseYear === priorYear) return 0
  return store.updatePriorYearCloses(closes, priorYear)
}

interface PriceReport {
  source: 'factset' | 'polygon'
  updated: number
  unmapped: string[]
  unpriced: string[]
  yearEndCloses: number
}

/** Update prices only: FactSet when credentials exist, Polygon otherwise. */
async function runPriceUpdate(): Promise<PriceReport> {
  const tickers = await liveTickers()
  const creds = credentialsFromEnv()

  if (creds) {
    const prices = await fetchFactSetPrices(creds, tickers)
    const updated = await store.updatePrices(prices)
    const unpriced = tickers.filter((t) => !(t in prices))
    const yearEndCloses = await ensureYearEndCloses(tickers)
    return { source: 'factset', updated, unmapped: [], unpriced, yearEndCloses }
  }

  const apiKey = polygonApiKeyFromEnv()
  if (!apiKey) {
    throw new RefreshError(
      'No price source configured. Set POLYGON_API_KEY (a free key from polygon.io) ' +
        'or FactSet credentials.',
      503,
    )
  }
  const result = await fetchPolygonPrices(tickers, {
    apiKey,
    baseUrl: process.env.POLYGON_BASE_URL,
  })
  const updated = await store.updatePrices(result.prices)
  const yearEndCloses = await ensureYearEndCloses(tickers)
  return {
    source: 'polygon',
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
      try {
        if (factsetFresh) {
          // The estimates pull already carried live prices; only the YTD
          // baseline may still be missing.
          const closes = await ensureYearEndCloses(await liveTickers())
          if (closes) console.log(`Daily year-end closes: ${closes} fetched`)
        } else {
          const report = await runPriceUpdate()
          console.log(
            `Daily price update (${report.source}): ${report.updated} priced, ` +
              `${report.unpriced.length} unpriced, ${report.unmapped.length} unmapped` +
              (report.yearEndCloses ? `, ${report.yearEndCloses} year-end closes` : ''),
          )
          if (report.unpriced.length) {
            console.log(`Unpriced tickers: ${report.unpriced.join(', ')}`)
          }
        }
      } catch (error) {
        console.error(
          'Daily price update failed:',
          error instanceof Error ? error.message : error,
        )
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

/**
 * Store a backfilled snapshot for a past date (see scripts/backfill-snapshot.ts).
 * Today's snapshot belongs to the daily task and cannot be overwritten here.
 */
app.put('/api/history/:date', route(async (req, res) => {
  const raw = req.params.date
  const date = String(Array.isArray(raw) ? raw[0] : raw)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date >= todayKey()) {
    res.status(400).json({ error: 'Backfill takes a past date in YYYY-MM-DD form' })
    return
  }
  const body = req.body as { date?: unknown; companies?: unknown }
  if (body?.date !== date || typeof body.companies !== 'object' || body.companies === null) {
    res.status(400).json({ error: 'Body must be a snapshot whose date matches the URL' })
    return
  }
  await mkdir(historyDir(), { recursive: true })
  await writeFile(
    path.join(historyDir(), `${date}.json`),
    JSON.stringify(body) + '\n',
    'utf8',
  )
  res.json({ ok: true, date, companies: Object.keys(body.companies).length })
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
/**
 * Every tab as one Excel workbook: Summary movers, the Master Input grids
 * (source tier as font colour), Screen, both peers tabs with constituents,
 * and the Changes comparison — all against the latest prior snapshot.
 */
app.get('/api/export.xlsx', route(async (_req, res) => {
  const inputs = await loadInputs()
  const dashboard = buildDashboard(inputs)
  const today = todayKey()

  const dates = (await listSnapshots(historyDir())).filter((d) => d < today)
  const date = dates[dates.length - 1]
  let compare: { snapshot: MoverSnapshot; date: string } | null = null
  if (date) {
    const snapshot = await readSnapshot(historyDir(), date)
    if (snapshot) compare = { snapshot, date }
  }

  const workbook = buildExportWorkbook(dashboard, compare)
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="valuation-dashboard-${today}.xlsx"`,
  )
  await workbook.xlsx.write(res)
  res.end()
}))

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

/** The comp-group membership audit log, newest change first. */
app.get('/api/groups/audit', route(async (_req, res) => {
  const log = await store.loadGroupAudit()
  res.json({ entries: [...log.entries].reverse() })
}))

/**
 * Add a brand-new company to the universe. Identity only — inputs are typed
 * into Master Input afterwards, the price arrives with the next update, and
 * group membership is assigned on the peers tabs.
 */
app.post('/api/companies', route(async (req, res) => {
  const body = req.body as {
    ticker?: unknown
    name?: unknown
    fiscalYearEnd?: unknown
    covered?: unknown
    priorYearClose?: unknown
  }
  if (
    typeof body.ticker !== 'string' ||
    typeof body.name !== 'string' ||
    typeof body.fiscalYearEnd !== 'number'
  ) {
    res.status(400).json({ error: 'Expected ticker, name and fiscalYearEnd (month 1-12)' })
    return
  }
  try {
    const meta = await store.addCompany({
      ticker: body.ticker,
      name: body.name,
      fiscalYearEnd: body.fiscalYearEnd,
      covered: body.covered === true,
    })
    // A hand-entered prior year-end close makes YTD work from day one for
    // names the free feed has no baseline for.
    if (typeof body.priorYearClose === 'number' && body.priorYearClose > 0) {
      await store.patchOverride(meta.ticker, { priorYearClose: body.priorYearClose })
    }
    res.json({ ok: true, company: meta })
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
  }
}))

/**
 * Pull fresh data from FactSet into the factset tier, on demand. Overrides
 * and own models are stored separately and are untouched by a refresh.
 */
/** Prices only: FactSet when credentials exist, the free EOD feed otherwise. */
app.post('/api/refresh-prices', route(async (_req, res) => {
  if (refreshState.running) {
    res.status(409).json({ error: 'A refresh is already running.' })
    return
  }
  refreshState.running = true
  try {
    const report = await runPriceUpdate()
    res.json({ ok: true, mode: 'prices', ...report })
  } finally {
    refreshState.running = false
  }
}))

/** Estimates (and everything else FactSet carries): credentials required. */
app.post('/api/refresh', route(async (_req, res) => {
  try {
    const result = await runFactSetRefresh()
    res.json({ ok: true, mode: 'factset', ...result })
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

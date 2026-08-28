import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

import { DataStore } from '../src/lib/store.js'
import { buildDashboard, type DashboardInputs } from '../src/lib/dashboard.js'
import { credentialsFromEnv, fetchFactSet } from '../src/factset/client.js'
import type { OverrideEntry, OwnModel } from '../src/lib/types.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const store = new DataStore(process.env.DATA_DIR ?? path.join(root, 'data'))
const port = Number(process.env.PORT ?? 8787)

const app = express()
app.use(express.json({ limit: '4mb' }))

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

app.get('/api/dashboard', route(async (req, res) => {
  const inputs = await loadInputs()
  const year = typeof req.query.year === 'string' ? req.query.year : undefined
  res.json(buildDashboard(inputs, year))
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

app.delete('/api/company/:ticker/override', route(async (req, res) => {
  await store.clearOverrides(tickerParam(req))
  res.json({ ok: true })
}))

/** Replace a covered company's own model. */
app.put('/api/company/:ticker/model', route(async (req, res) => {
  const ticker = tickerParam(req)
  const model = { ...(req.body as OwnModel), ticker }
  await store.saveModel(model)
  res.json(model)
}))

/**
 * Pull fresh data from FactSet into the factset tier. Overrides and own models
 * are stored separately and are untouched by a refresh.
 */
app.post('/api/refresh', route(async (_req, res) => {
  const creds = credentialsFromEnv()
  if (!creds) {
    res.status(503).json({
      error:
        'FactSet credentials not configured. Set FACTSET_USERNAME_SERIAL and FACTSET_API_KEY.',
    })
    return
  }
  const universe = await store.loadUniverse()
  const currentYear = new Date().getFullYear()
  const years = Array.from({ length: 11 }, (_, i) => currentYear - 8 + i)
  const cache = await fetchFactSet(
    creds,
    universe.companies.map((c) => ({ ticker: c.ticker, fiscalYearEnd: c.fiscalYearEnd })),
    { years },
  )
  await store.saveFactSet(cache)
  res.json({ ok: true, asOf: cache.asOf, companies: Object.keys(cache.companies).length })
}))

const dist = path.join(root, 'dist')
if (existsSync(dist)) {
  app.use(express.static(dist))
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')))
}

app.use(((err, _req, res, _next) => {
  console.error(err)
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
}) as express.ErrorRequestHandler)

app.listen(port, () => {
  console.log(`Valuation dashboard API on http://localhost:${port}`)
})

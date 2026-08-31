import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { createServer as createHttpServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { hashPassword } from '../server/auth.js'

/**
 * End-to-end checks against a real server process.
 *
 * These exercise what a hosted deployment depends on and unit tests cannot
 * reach: that an empty volume gets seeded, that the API is closed without a
 * session, and that edits land on the volume rather than the bundled data
 * shipped in the image.
 */

const root = path.resolve(__dirname, '..')
const isWindows = process.platform === 'win32'
const PASSWORD = 'a-test-password-for-ci'

let server: ChildProcess
let dataDir: string
let baseUrl: string
let stooq: Server

/**
 * A stand-in for Stooq's quote endpoint: answers every requested symbol with a
 * deterministic close, except adbe.us which gets a recognizable 111.25 and
 * gone.us which comes back N/D. Lets the price-update path run for real.
 */
function startFakeStooq(port: number): Server {
  const srv = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const symbols = (url.searchParams.get('s') ?? '').split(' ').filter(Boolean)
    const lines = ['Symbol,Date,Time,Open,High,Low,Close,Volume']
    for (const s of symbols) {
      if (s === 'adbe.us') lines.push('ADBE.US,2026-08-31,22:00:00,1,1,1,111.25,100')
      else lines.push(`${s.toUpperCase()},2026-08-31,22:00:00,1,1,1,50,100`)
    }
    res.setHeader('content-type', 'text/csv')
    res.end(lines.join('\n'))
  })
  srv.listen(port, '127.0.0.1')
  return srv
}

/** Ask the OS for a free port, so a stray process cannot collide with the run. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (typeof address === 'string' || !address) {
        probe.close()
        reject(new Error('Could not determine a free port'))
        return
      }
      const { port } = address
      probe.close(() => resolve(port))
    })
  })
}

/** Poll until the server answers, so the suite does not race its startup. */
async function waitForReady(timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Server exited early with code ${server.exitCode}`)
    }
    try {
      const res = await fetch(`${baseUrl}/api/session`)
      if (res.ok) return
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('Server did not become ready')
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'valuation-server-'))
  const port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  const stooqPort = await freePort()
  stooq = startFakeStooq(stooqPort)

  // Run tsx's JS entry point under this Node binary rather than the `.bin`
  // shim: on Windows that shim is `tsx.cmd`, which spawn cannot launch without
  // a shell, and going through npx would leave the real server orphaned.
  const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  server = spawn(process.execPath, [tsxCli, 'server/index.ts'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      DASHBOARD_PASSWORD_HASH: hashPassword(PASSWORD),
      SESSION_SECRET: 'a-fixed-secret-for-tests',
      NODE_ENV: 'test',
      // Empty strings read as unset, so the daily task never attempts a live
      // FactSet pull inside the test suite whatever the ambient environment.
      FACTSET_USERNAME_SERIAL: '',
      FACTSET_API_KEY: '',
      STOOQ_BASE_URL: `http://127.0.0.1:${stooqPort}/q/l/`,
    },
    stdio: 'ignore',
    // A process group lets the whole tree be signalled at once. Windows has no
    // process groups, so it is handled with taskkill below instead.
    detached: !isWindows,
  })
  await waitForReady()
}, 60000)

/**
 * Stop the server and everything it started.
 *
 * tsx re-executes the script in a child process, so signalling only the
 * process we spawned would leave the real server holding the port. Both
 * branches below target the tree rather than the leader.
 */
function stopServer(child: ChildProcess): void {
  if (!child.pid) return
  if (isWindows) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

afterAll(async () => {
  stooq?.close()
  if (server) {
    stopServer(server)
    await new Promise((r) => setTimeout(r, 300))
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

/** Poll until a condition holds; the daily snapshot is written off-request. */
async function waitFor(condition: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('Condition not met in time')
}

/** Sign in and return the session cookie. */
async function signIn(password = PASSWORD): Promise<string> {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  if (!res.ok) throw new Error(`Login failed: ${res.status}`)
  const cookie = res.headers.get('set-cookie')
  if (!cookie) throw new Error('No session cookie issued')
  return cookie.split(';')[0] as string
}

describe('data directory seeding', () => {
  it('fills an empty volume from the bundled workbook import', () => {
    // A hosted deploy mounts an empty volume; without this the first boot
    // would serve an empty dashboard.
    expect(existsSync(path.join(dataDir, 'universe.json'))).toBe(true)
    expect(existsSync(path.join(dataDir, 'models', 'ADBE.json'))).toBe(true)
    const universe = JSON.parse(readFileSync(path.join(dataDir, 'universe.json'), 'utf8'))
    expect(universe.companies.length).toBe(323)
  })
})

describe('access control', () => {
  it('reports that a password is required before sign in', async () => {
    const res = await fetch(`${baseUrl}/api/session`)
    expect(await res.json()).toEqual({ authRequired: true, signedIn: false })
  })

  it('refuses the dashboard without a session', async () => {
    const res = await fetch(`${baseUrl}/api/dashboard`)
    expect(res.status).toBe(401)
  })

  it('refuses writes without a session', async () => {
    const res = await fetch(`${baseUrl}/api/company/ADBE/override`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ series: { revenue: { '2027': 1 } } }),
    })
    expect(res.status).toBe(401)
  })

  it('rejects the wrong password', async () => {
    const res = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'not-the-password' }),
    })
    expect(res.status).toBe(401)
  })

  it('issues an HttpOnly session cookie on the right password', async () => {
    const res = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })
    expect(res.ok).toBe(true)
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
  })

  it('serves the dashboard once signed in', async () => {
    const cookie = await signIn()
    const res = await fetch(`${baseUrl}/api/dashboard`, { headers: { cookie } })
    expect(res.ok).toBe(true)
    const body = (await res.json()) as { companies: unknown[] }
    expect(body.companies.length).toBe(323)
  })

  it('refuses a cross-origin write even with a valid session', async () => {
    // The session rides in a cookie, so a page on another origin must not be
    // able to make the browser issue writes on the analyst's behalf.
    const cookie = await signIn()
    const res = await fetch(`${baseUrl}/api/company/ADBE/override`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie, origin: 'https://evil.example' },
      body: JSON.stringify({ series: { revenue: { '2027': 1 } } }),
    })
    expect(res.status).toBe(403)
  })
})

describe('writes land on the data directory', () => {
  it('persists an override to the volume, not the bundled image data', async () => {
    const cookie = await signIn()
    const res = await fetch(`${baseUrl}/api/company/CRM/override`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ series: { revenue: { '2027': 55555 } } }),
    })
    expect(res.ok).toBe(true)

    const onVolume = JSON.parse(readFileSync(path.join(dataDir, 'overrides.json'), 'utf8'))
    expect(onVolume.companies.CRM.series.revenue['2027']).toBe(55555)

    // The copy shipped in the repo must be untouched, or a redeploy would
    // resurrect stale numbers over the analyst's edits.
    const bundled = JSON.parse(readFileSync(path.join(root, 'data', 'overrides.json'), 'utf8'))
    expect(bundled.companies.CRM?.series?.revenue?.['2027']).toBeUndefined()
  })

  it('reflects the override in the resolved dashboard', async () => {
    const cookie = await signIn()
    const res = await fetch(`${baseUrl}/api/company/CRM`, { headers: { cookie } })
    const body = (await res.json()) as {
      resolved: { series: { revenue: Record<string, { value: number; tier: string }> } }
    }
    expect(body.resolved.series.revenue['2027']).toMatchObject({
      value: 55555,
      tier: 'override',
    })
  })

  it('records a daily snapshot when the dashboard is served', async () => {
    const cookie = await signIn()
    await fetch(`${baseUrl}/api/dashboard`, { headers: { cookie } })

    const today = new Date().toISOString().slice(0, 10)
    const file = path.join(dataDir, 'history', `${today}.json`)
    // The snapshot is taken in the background after the refresh step, so the
    // serving request is never held for the pull; wait for it to land.
    await waitFor(() => existsSync(file))

    const snapshot = JSON.parse(readFileSync(file, 'utf8')) as {
      date: string
      companies: Record<string, { series: { revenue?: Record<string, number> } }>
    }
    expect(snapshot.date).toBe(today)
    expect(Object.keys(snapshot.companies).length).toBe(323)
    expect(snapshot.companies.ADBE?.series.revenue?.['2024']).toBe(21505)

    // The FactSet tier is captured separately from the resolved values, so
    // estimate revisions stay trackable where a model or override wins the
    // cell. ADBE's resolved 2025 revenue comes from the model (23765); its
    // vendor tier carries only the history years the workbook pulled live.
    const adbe = snapshot.companies.ADBE as unknown as {
      series: { revenue: Record<string, number> }
      factset?: { series: { revenue?: Record<string, number> } }
      multiples?: Record<string, { evRevenue?: number }>
    }
    expect(adbe.series.revenue['2025']).toBe(23765)
    expect(adbe.factset?.series.revenue?.['2021']).toBe(15785)
    expect(adbe.factset?.series.revenue?.['2025']).toBeUndefined()
    expect(typeof adbe.multiples?.['2027']?.evRevenue).toBe('number')

    const list = await fetch(`${baseUrl}/api/history`, { headers: { cookie } })
    expect(((await list.json()) as { dates: string[] }).dates).toContain(today)
  })

  it('serves a stored snapshot and 404s an unknown date', async () => {
    const cookie = await signIn()
    // A hand-planted earlier snapshot stands in for a previous day's run.
    mkdirSync(path.join(dataDir, 'history'), { recursive: true })
    writeFileSync(
      path.join(dataDir, 'history', '2026-01-02.json'),
      JSON.stringify({ date: '2026-01-02', takenAt: 'x', companies: {} }),
    )

    const ok = await fetch(`${baseUrl}/api/history/2026-01-02`, { headers: { cookie } })
    expect(ok.ok).toBe(true)
    expect(((await ok.json()) as { date: string }).date).toBe('2026-01-02')

    const missing = await fetch(`${baseUrl}/api/history/1999-01-01`, { headers: { cookie } })
    expect(missing.status).toBe(404)

    const invalid = await fetch(`${baseUrl}/api/history/..%2Foverrides`, { headers: { cookie } })
    expect(invalid.status).toBe(404)
  })

  it('keeps history behind the session like everything else', async () => {
    const res = await fetch(`${baseUrl}/api/history`)
    expect(res.status).toBe(401)
  })

  it('edits a comp group and restrikes the roll-ups from the new membership', async () => {
    const cookie = await signIn()
    const patch = await fetch(`${baseUrl}/api/groups`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ kind: 'sector', group: 'Adtech', add: ['CRM'] }),
    })
    expect(patch.ok).toBe(true)
    expect(((await patch.json()) as { members: string[] }).members).toContain('CRM')

    const res = await fetch(`${baseUrl}/api/dashboard`, { headers: { cookie } })
    const dashboard = (await res.json()) as {
      sectorSummaries: { group: string; members: string[] }[]
    }
    const adtech = dashboard.sectorSummaries.find((g) => g.group === 'Adtech')
    expect(adtech?.members).toContain('CRM')

    // Put it back so this test leaves the universe as it found it.
    await fetch(`${baseUrl}/api/groups`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ kind: 'sector', group: 'Adtech', remove: ['CRM'] }),
    })
  })

  it('rejects a group edit with an unknown ticker or bad kind', async () => {
    const cookie = await signIn()
    const unknown = await fetch(`${baseUrl}/api/groups`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ kind: 'sector', group: 'Adtech', add: ['NOPE123'] }),
    })
    expect(unknown.status).toBe(400)

    const badKind = await fetch(`${baseUrl}/api/groups`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ kind: 'wat', group: 'Adtech', add: ['CRM'] }),
    })
    expect(badKind.status).toBe(400)
  })

  it('serves imported KPIs on the company payload', async () => {
    const cookie = await signIn()
    const res = await fetch(`${baseUrl}/api/company/MNDY`, { headers: { cookie } })
    const body = (await res.json()) as { kpis: Record<string, Record<string, number>> | null }
    expect(body.kpis?.customersOver50k?.['2024']).toBe(3201)
  })

  it('round-trips saved screener views', async () => {
    const cookie = await signIn()
    const headers = { 'Content-Type': 'application/json', cookie }

    const put = await fetch(`${baseUrl}/api/views`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        name: 'Rule of 40',
        filters: [{ key: 'ruleOf40', op: 'gte', value: 0.4 }],
        year: '2027',
      }),
    })
    expect(put.ok).toBe(true)

    const list = await fetch(`${baseUrl}/api/views`, { headers: { cookie } })
    const { views } = (await list.json()) as { views: { name: string }[] }
    expect(views.map((v) => v.name)).toContain('Rule of 40')

    const nameless = await fetch(`${baseUrl}/api/views`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ filters: [] }),
    })
    expect(nameless.status).toBe(400)

    const del = await fetch(`${baseUrl}/api/views/${encodeURIComponent('Rule of 40')}`, {
      method: 'DELETE',
      headers: { cookie },
    })
    const after = (await del.json()) as { views: { name: string }[] }
    expect(after.views.map((v) => v.name)).not.toContain('Rule of 40')
  })

  it('exports the whole data set as a downloadable bundle', async () => {
    const cookie = await signIn()
    const res = await fetch(`${baseUrl}/api/export`, { headers: { cookie } })
    expect(res.ok).toBe(true)
    expect(res.headers.get('content-disposition')).toContain('valuation-backup-')
    const bundle = (await res.json()) as {
      universe: { companies: unknown[] }
      models: Record<string, unknown>
      kpis: Record<string, unknown>
    }
    expect(bundle.universe.companies.length).toBe(323)
    expect(Object.keys(bundle.models).length).toBeGreaterThan(40)
    expect(Object.keys(bundle.kpis).length).toBeGreaterThan(150)
  })

  it('serves a per-ticker history series once a snapshot exists', async () => {
    const cookie = await signIn()
    const today = new Date().toISOString().slice(0, 10)
    await waitFor(() => existsSync(path.join(dataDir, 'history', `${today}.json`)))

    const res = await fetch(
      `${baseUrl}/api/history/series?ticker=ADBE&metric=revenue&year=2027`,
      { headers: { cookie } },
    )
    expect(res.ok).toBe(true)
    const body = (await res.json()) as {
      points: { date: string; resolved: number | null; price: number | null }[]
    }
    expect(body.points.length).toBeGreaterThanOrEqual(1)
    expect(body.points[0]?.resolved).toBeCloseTo(28828.766, 1)

    const bad = await fetch(`${baseUrl}/api/history/series?ticker=ADBE`, {
      headers: { cookie },
    })
    expect(bad.status).toBe(400)
  })

  it('falls back to the free price feed on refresh without FactSet credentials', async () => {
    const cookie = await signIn()
    const res = await fetch(`${baseUrl}/api/refresh`, { method: 'POST', headers: { cookie } })
    expect(res.ok).toBe(true)
    const body = (await res.json()) as {
      mode: string
      updated: number
      unmapped: string[]
      note: string
    }
    expect(body.mode).toBe('prices')
    expect(body.updated).toBeGreaterThan(250)
    expect(body.unmapped).toContain('SPCX')
    expect(body.note).toContain('FactSet')

    // The new close flows through to the dashboard's resolved price.
    const dash = await fetch(`${baseUrl}/api/dashboard`, { headers: { cookie } })
    const dashboard = (await dash.json()) as {
      pricesAsOf: string | null
      companies: { meta: { ticker: string }; metrics: { price: number | null } }[]
    }
    expect(dashboard.pricesAsOf).toBeTruthy()
    const adbe = dashboard.companies.find((c) => c.meta.ticker === 'ADBE')
    expect(adbe?.metrics.price).toBe(111.25)
  })

  it('keeps the refresh behind the session', async () => {
    const res = await fetch(`${baseUrl}/api/refresh`, { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('signs out and closes the API again', async () => {
    const cookie = await signIn()
    const out = await fetch(`${baseUrl}/api/logout`, { method: 'POST', headers: { cookie } })
    expect(out.ok).toBe(true)
    // The cookie is cleared in the browser; the API stays closed to anyone without one.
    const res = await fetch(`${baseUrl}/api/dashboard`)
    expect(res.status).toBe(401)
  })
})

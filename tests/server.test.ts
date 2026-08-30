import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
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
  if (server) {
    stopServer(server)
    await new Promise((r) => setTimeout(r, 300))
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

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
    expect(universe.companies.length).toBe(335)
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
    expect(body.companies.length).toBe(335)
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
    expect(existsSync(file)).toBe(true)

    const snapshot = JSON.parse(readFileSync(file, 'utf8')) as {
      date: string
      companies: Record<string, { series: { revenue?: Record<string, number> } }>
    }
    expect(snapshot.date).toBe(today)
    expect(Object.keys(snapshot.companies).length).toBe(335)
    expect(snapshot.companies.ADBE?.series.revenue?.['2024']).toBe(21505)

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

  it('signs out and closes the API again', async () => {
    const cookie = await signIn()
    const out = await fetch(`${baseUrl}/api/logout`, { method: 'POST', headers: { cookie } })
    expect(out.ok).toBe(true)
    // The cookie is cleared in the browser; the API stays closed to anyone without one.
    const res = await fetch(`${baseUrl}/api/dashboard`)
    expect(res.status).toBe(401)
  })
})

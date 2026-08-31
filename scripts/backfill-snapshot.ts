/**
 * Turn an old copy of the valuation workbook into a history snapshot, so the
 * app's change-tracking reaches back before the app existed.
 *
 * Two steps per historical file:
 *
 *   python3 scripts/extract_workbook.py "2025-06-30 file.xlsx" --out /tmp/asof
 *   npx tsx scripts/backfill-snapshot.ts --data /tmp/asof --date 2025-06-30
 *
 * The extracted tiers are run through the same resolver and metrics engine as
 * the live app, so a backfilled snapshot is exactly what the daily task would
 * have recorded on that date. Output lands in data/history/<date>.json by
 * default; pass --push and --password to send it to a deployed instance
 * instead (the server stores it on the volume).
 */

import path from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'

import { DataStore } from '../src/lib/store.js'
import { buildDashboard } from '../src/lib/dashboard.js'
import { buildSnapshot } from '../server/history.js'

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function main(): Promise<void> {
  const dataDir = flag('data')
  const date = flag('date')
  if (!dataDir || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(
      'Usage: tsx scripts/backfill-snapshot.ts --data <extracted-dir> --date YYYY-MM-DD ' +
        '[--out data/history] [--push https://app.fly.dev --password <dashboard password>]',
    )
  }

  const store = new DataStore(dataDir)
  const [universe, factset, overrides, models] = await Promise.all([
    store.loadUniverse(),
    store.loadFactSet(),
    store.loadOverrides(),
    store.loadModels(),
  ])
  const dashboard = buildDashboard({ universe, factset, overrides, models })
  const snapshot = buildSnapshot(dashboard, date)
  const body = JSON.stringify(snapshot)
  console.log(`${date}: ${Object.keys(snapshot.companies).length} companies snapshotted`)

  const push = flag('push')
  if (push) {
    const password = flag('password')
    if (!password) throw new Error('--push needs --password (the dashboard sign-in password)')

    const login = await fetch(`${push.replace(/\/$/, '')}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (!login.ok) throw new Error(`Sign-in failed: ${login.status} ${await login.text()}`)
    const cookie = login.headers.get('set-cookie')?.split(';')[0]
    if (!cookie) throw new Error('No session cookie returned')

    const res = await fetch(`${push.replace(/\/$/, '')}/api/history/${date}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body,
    })
    if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`)
    console.log(`Pushed to ${push}`)
    return
  }

  const outDir = flag('out') ?? path.join('data', 'history')
  await mkdir(outDir, { recursive: true })
  const target = path.join(outDir, `${date}.json`)
  await writeFile(target, body + '\n', 'utf8')
  console.log(`Wrote ${target}`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

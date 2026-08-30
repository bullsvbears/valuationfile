import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

import type { Dashboard } from '../src/lib/dashboard.js'
import { METRIC_KEYS, type MetricKey } from '../src/lib/types.js'

/**
 * Daily snapshots of the resolved inputs, so the dashboard can answer "how has
 * this number moved since last week?" — the question the source workbook's
 * Today / Last Week / % Delta columns existed for.
 *
 * One JSON file per calendar day, written the first time the dashboard is
 * served that day. Snapshots capture resolved values — whatever tier was live
 * wins — because that is the number the analyst was actually looking at.
 * They live under the data directory (the volume, when hosted) and are
 * runtime state, not seed data: they are gitignored and never shipped in the
 * image.
 */

export interface SnapshotCompany {
  price: number | null
  shares: number | null
  cash: number | null
  debt: number | null
  series: Partial<Record<MetricKey, Record<string, number>>>
}

export interface Snapshot {
  date: string
  takenAt: string
  companies: Record<string, SnapshotCompany>
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function todayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

function fileFor(dir: string, date: string): string {
  return path.join(dir, `${date}.json`)
}

export function buildSnapshot(dashboard: Dashboard, date: string): Snapshot {
  const companies: Record<string, SnapshotCompany> = {}
  for (const company of dashboard.companies) {
    const series: SnapshotCompany['series'] = {}
    for (const metric of METRIC_KEYS) {
      const years: Record<string, number> = {}
      for (const [year, cell] of Object.entries(company.resolved.series[metric])) {
        if (cell.value !== null) years[year] = cell.value
      }
      if (Object.keys(years).length) series[metric] = years
    }
    companies[company.meta.ticker] = {
      price: company.metrics.price,
      shares: company.resolved.balance.shares.value,
      cash: company.resolved.balance.cash.value,
      debt: company.resolved.balance.debt.value,
      series,
    }
  }
  return { date, takenAt: new Date().toISOString(), companies }
}

/** Write today's snapshot if it does not exist yet. Idempotent per day. */
export async function ensureDailySnapshot(
  dir: string,
  dashboard: Dashboard,
  date = todayKey(),
): Promise<boolean> {
  if (existsSync(fileFor(dir, date))) return false
  await mkdir(dir, { recursive: true })
  const temp = fileFor(dir, date) + '.tmp'
  await writeFile(temp, JSON.stringify(buildSnapshot(dashboard, date)) + '\n', 'utf8')
  await rename(temp, fileFor(dir, date))
  return true
}

/** Snapshot dates on disk, oldest first. */
export async function listSnapshots(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  const entries = await readdir(dir)
  return entries
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''))
    .filter((date) => DATE_PATTERN.test(date))
    .sort()
}

export async function readSnapshot(dir: string, date: string): Promise<Snapshot | null> {
  if (!DATE_PATTERN.test(date)) return null
  const file = fileFor(dir, date)
  if (!existsSync(file)) return null
  return JSON.parse(await readFile(file, 'utf8')) as Snapshot
}

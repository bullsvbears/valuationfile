/**
 * Refresh the FactSet tier from the Formula API.
 *
 * Overrides and own models live in separate files and are untouched: a refresh
 * moves the consensus baseline underneath them, and any cell an analyst has
 * taken a view on keeps that view.
 *
 *   FACTSET_USERNAME_SERIAL=... FACTSET_API_KEY=... npm run refresh
 *
 * Options:
 *   --years 2018-2028   calendar years to pull (default: eight back, two forward)
 *   --tickers CRM,ADBE  restrict the pull, for a quick check against one name
 *   --dry-run           print what would be requested without calling FactSet
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DataStore } from '../src/lib/store.js'
import { credentialsFromEnv, fetchFactSet } from '../src/factset/client.js'
import { companyFormulas } from '../src/factset/fql.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

function parseYears(spec: string | undefined): number[] {
  if (!spec) {
    const current = new Date().getFullYear()
    return Array.from({ length: 11 }, (_, i) => current - 8 + i)
  }
  const [from, to] = spec.split('-').map(Number)
  if (!from || !to || to < from) throw new Error(`Invalid --years "${spec}", expected 2018-2028`)
  return Array.from({ length: to - from + 1 }, (_, i) => from + i)
}

async function main(): Promise<void> {
  const store = new DataStore(process.env.DATA_DIR ?? path.join(root, 'data'))
  const universe = await store.loadUniverse()
  const years = parseYears(flag('years'))

  const only = flag('tickers')?.split(',').map((t) => t.trim().toUpperCase())
  const targets = universe.companies
    .filter((c) => !only || only.includes(c.ticker))
    .map((c) => ({ ticker: c.ticker, fiscalYearEnd: c.fiscalYearEnd }))

  if (!targets.length) throw new Error('No companies matched; check --tickers')

  if (process.argv.includes('--dry-run')) {
    const sample = targets[0]!
    console.log(`Would request ${targets.length} companies for ${years[0]}-${years.at(-1)}.`)
    console.log(`\nFormulas for ${sample.ticker} (fiscal year end ${sample.fiscalYearEnd}):`)
    for (const [alias, formula] of Object.entries(companyFormulas(sample.fiscalYearEnd, years))) {
      console.log(`  ${alias.padEnd(18)} ${formula}`)
    }
    return
  }

  const creds = credentialsFromEnv()
  if (!creds) {
    throw new Error(
      'Set FACTSET_USERNAME_SERIAL and FACTSET_API_KEY, or pass --dry-run to see the request.',
    )
  }

  console.log(`Requesting ${targets.length} companies for ${years[0]}-${years.at(-1)}…`)
  const cache = await fetchFactSet(creds, targets, { years })

  // A partial pull must not blank out the companies it did not cover.
  if (only) {
    const existing = await store.loadFactSet()
    cache.companies = { ...existing.companies, ...cache.companies }
  }

  await store.saveFactSet(cache)
  console.log(`Saved ${Object.keys(cache.companies).length} companies, as of ${cache.asOf}.`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

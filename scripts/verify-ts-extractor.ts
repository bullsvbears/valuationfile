/**
 * Diff src/workbook/extract.ts against the committed data/ files that
 * scripts/extract_workbook.py produced from the same workbook.
 *
 *   npx tsx scripts/verify-ts-extractor.ts <workbook.xlsx> [dataDir]
 *
 * Exits non-zero on any mismatch; prints a per-section summary otherwise.
 * Timestamps and import notes differ by design and are ignored.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { extractWorkbook } from '../src/workbook/extract.js'

const workbookPath = process.argv[2]
const dataDir = process.argv[3] ?? path.join(import.meta.dirname, '..', 'data')
if (!workbookPath) {
  console.error('usage: npx tsx scripts/verify-ts-extractor.ts <workbook.xlsx> [dataDir]')
  process.exit(2)
}

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'))

const problems: string[] = []
const flag = (msg: string) => {
  problems.push(msg)
  if (problems.length <= 40) console.error('MISMATCH', msg)
}

const close = (a: unknown, b: unknown): boolean => {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))
  }
  return a === b
}

/** Deep-compare, numbers with tolerance, reporting the path of any diff. */
function diff(label: string, ours: unknown, theirs: unknown): void {
  if (ours === null || theirs === null || typeof ours !== 'object' || typeof theirs !== 'object') {
    if (!close(ours, theirs)) flag(`${label}: ${JSON.stringify(ours)} != ${JSON.stringify(theirs)}`)
    return
  }
  const a = ours as Record<string, unknown>
  const b = theirs as Record<string, unknown>
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!(key in a)) flag(`${label}.${key}: missing in TS output`)
    else if (!(key in b)) flag(`${label}.${key}: extra in TS output`)
    else diff(`${label}.${key}`, a[key], b[key])
  }
}

const buffer = readFileSync(workbookPath)
const extracted = await extractWorkbook(buffer)

// universe
const universe = readJson(path.join(dataDir, 'universe.json'))
diff('universe', extracted.universe, universe)

// factset layer: companies must match; asOf/source are run metadata.
const factset = readJson(path.join(dataDir, 'factset-cache.json'))
diff('factset.companies', extracted.factset.companies, factset.companies)

// overrides: importNote wording differs between importers by design.
const overrides = readJson(path.join(dataDir, 'overrides.json'))
const scrub = (store: { companies: Record<string, { importNote?: string }> }) =>
  Object.fromEntries(
    Object.entries(store.companies).map(([t, e]) => [t, { ...e, importNote: undefined }]),
  )
diff('overrides', scrub(extracted.overrides as never), scrub(overrides))

// models: one committed file per ticker.
const modelDir = path.join(dataDir, 'models')
const committedModels: Record<string, unknown> = {}
for (const file of readdirSync(modelDir)) {
  if (file.endsWith('.json')) {
    committedModels[file.replace(/\.json$/, '')] = readJson(path.join(modelDir, file))
  }
}
diff('models', extracted.models, committedModels)

console.log('--- summary ---')
console.log('companies :', extracted.universe.companies.length, 'vs', universe.companies.length)
console.log('factset   :', Object.keys(extracted.factset.companies).length, 'vs', Object.keys(factset.companies).length)
console.log('overrides :', Object.keys(extracted.overrides.companies).length, 'vs', Object.keys(overrides.companies).length)
console.log('models    :', Object.keys(extracted.models).length, 'vs', Object.keys(committedModels).length)
if (problems.length > 0) {
  console.error(`FAILED with ${problems.length} mismatches`)
  process.exit(1)
}
console.log('extractor output matches the Python ground truth')

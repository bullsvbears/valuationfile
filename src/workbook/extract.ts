import ExcelJS from 'exceljs'

import type { Universe } from '../lib/store.js'
import type {
  CompanyFacts,
  FactSetCache,
  MetricKey,
  OverrideEntry,
  OverrideStore,
  OwnModel,
} from '../lib/types.js'

/**
 * In-process port of scripts/extract_workbook.py, so an old copy of the
 * valuation workbook can be uploaded through the app and turned into a
 * history snapshot server-side — no Python on the analyst's machine.
 *
 * The two implementations must agree cell for cell; scripts/verify-ts-extractor.ts
 * diffs this port against the Python output for the original workbook.
 * Layout constants below mirror the Python file — change them together.
 *
 * NOT wired to any server route right now: exceljs materialises the whole
 * workbook (~3.6GB heap for the real 10MB file, far beyond a small Fly VM),
 * which crashed the app behind 502s. Before re-exposing an upload endpoint,
 * parse only the four needed sheets — e.g. stub the other worksheet XML
 * entries inside the zip, or read the sheet XML directly — and measure the
 * peak under `--max-old-space-size` first. exceljs is a devDependency until
 * then, so keep server code from importing this module.
 */

// Column spans on the `Data` sheet, one contiguous block of years per metric.
const METRIC_BLOCKS: Record<MetricKey, [number, number]> = {
  revenue: [4, 14],
  grossProfit: [16, 25],
  ebitda: [27, 36],
  eps: [38, 47],
  fcf: [49, 58],
}
const BALANCE_COLUMNS = { shares: 60, cash: 61, debt: 62 } as const

const DATA_LAST_ROW = 352
const MASTER_LAST_ROW = 444

const EXTERNAL_LINK = /\[\d+\]/
const FACTSET_MARKERS = ['FE_ESTIMATE', 'FDS(', '_xll.']

type Tier = 'factset' | 'model' | 'override'

interface Extracted {
  universe: Universe
  factset: FactSetCache
  overrides: OverrideStore
  models: Record<string, OwnModel>
}

/**
 * A cell's value, with merged non-master cells read as empty — openpyxl's
 * read-only behaviour, which the Python extractor's output is built on.
 * exceljs instead propagates the master's value into every merged cell.
 */
function rawValue(cell: ExcelJS.Cell): ExcelJS.CellValue {
  if (cell.isMerged && cell.master !== cell) return null
  return cell.value
}

/** The formula text of a cell, resolving shared formulas to their master. */
function formulaText(sheet: ExcelJS.Worksheet, cell: ExcelJS.Cell): string | null {
  const value = rawValue(cell)
  if (value === null || typeof value !== 'object') return null
  const fv = value as ExcelJS.CellFormulaValue & { sharedFormula?: string }
  if (typeof fv.formula === 'string') return fv.formula
  if (typeof fv.sharedFormula === 'string') {
    const master = sheet.getCell(fv.sharedFormula).value
    if (master && typeof master === 'object' && 'formula' in master) {
      return (master as ExcelJS.CellFormulaValue).formula ?? null
    }
  }
  return null
}

/** The cached numeric result of a cell, formula or plain. */
function numberValue(cell: ExcelJS.Cell): number | null {
  const value = rawValue(cell)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value && typeof value === 'object') {
    const result = (value as ExcelJS.CellFormulaValue).result
    if (typeof result === 'number' && Number.isFinite(result)) return result
    if (result === undefined && ('formula' in value || 'sharedFormula' in value)) {
      // exceljs's value getter drops a cached result of 0; the model keeps it.
      const kept = (cell.model as { result?: unknown } | undefined)?.result
      if (typeof kept === 'number' && Number.isFinite(kept)) return kept
    }
  }
  return null
}

/** The cached string content of a cell, formula results included. */
function stringValue(cell: ExcelJS.Cell): string | null {
  const value = rawValue(cell)
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    if ('result' in value) {
      const result = (value as ExcelJS.CellFormulaValue).result
      if (typeof result === 'string') return result
    }
    if ('richText' in value) {
      return (value as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join('')
    }
  }
  return null
}

/** Map a cell to the tier that should own its value — same rules as Python. */
function classify(sheet: ExcelJS.Worksheet, cell: ExcelJS.Cell): Tier {
  const formula = formulaText(sheet, cell)
  if (formula === null) return 'override' // a hand-typed number
  if (FACTSET_MARKERS.some((marker) => formula.includes(marker))) return 'factset'
  if (EXTERNAL_LINK.test(formula)) return 'model' // link into the analyst's model workbook
  return 'factset' // derived in-sheet from FactSet-fed cells
}

/** Group memberships from the grouping sheets: a header row, then tickers. */
function readGroups(
  workbook: ExcelJS.Workbook,
  sheetName: string,
): Record<string, string[]> {
  const sheet = workbook.getWorksheet(sheetName)
  const groups: Record<string, string[]> = {}
  if (!sheet) return groups

  let current: string | null = null
  for (let row = 4; row <= sheet.rowCount; row += 1) {
    const label = stringValue(sheet.getCell(row, 2))?.trim()
    if (!label || label === 'Mean' || label === 'Median') continue
    const tickerCell = sheet.getCell(row, 3)
    if (rawValue(tickerCell) === null || rawValue(tickerCell) === undefined) {
      // A group header carries no ticker at all.
      current = label
      groups[current] ??= []
      continue
    }
    const ticker = stringValue(tickerCell)?.trim()
    if (ticker && current) groups[current]!.push(ticker)
  }
  return groups
}

/** Latest price and returns from the Master Software sheet. */
function readPrices(
  workbook: ExcelJS.Workbook,
): Record<string, { price: number | null; ytdReturn: number | null; priorYearReturn: number | null }> {
  const sheet = workbook.getWorksheet('Master Software')
  const prices: ReturnType<typeof readPrices> = {}
  if (!sheet) return prices

  for (let row = 6; row <= MASTER_LAST_ROW; row += 1) {
    const ticker = stringValue(sheet.getCell(row, 3))?.trim()
    if (!ticker) continue
    prices[ticker] = {
      price: numberValue(sheet.getCell(row, 4)),
      ytdReturn: numberValue(sheet.getCell(row, 5)),
      priorYearReturn: numberValue(sheet.getCell(row, 6)),
    }
  }
  return prices
}

/**
 * Extract the three data tiers from a workbook buffer.
 *
 * `importNote` labels the override cells this run produces, exactly as the
 * Python importer labels a fresh import.
 */
export async function extractWorkbook(
  buffer: Buffer | ArrayBuffer,
  importNote = 'Hard-coded cell imported from an uploaded workbook',
): Promise<Extracted> {
  const workbook = new ExcelJS.Workbook()
  // exceljs's Buffer typing predates Node's generic Buffer<ArrayBufferLike>.
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer)

  const data = workbook.getWorksheet('Data')
  if (!data) throw new Error('The workbook has no "Data" sheet — is this a valuation file?')

  const sectors = readGroups(workbook, 'Software Groups by Sector')
  const peerGroups = readGroups(workbook, 'Software Groups by Financials')
  const prices = readPrices(workbook)

  const sectorsByTicker = new Map<string, string[]>()
  for (const [name, members] of Object.entries(sectors)) {
    for (const t of members) sectorsByTicker.set(t, [...(sectorsByTicker.get(t) ?? []), name])
  }
  const peersByTicker = new Map<string, string[]>()
  for (const [name, members] of Object.entries(peerGroups)) {
    for (const t of members) peersByTicker.set(t, [...(peersByTicker.get(t) ?? []), name])
  }

  // Row 3 carries the calendar year for each column.
  const yearFor = (col: number): string | null => {
    const value = numberValue(data.getCell(3, col))
    return value === null ? null : String(Math.trunc(value))
  }

  const universe: Universe = { companies: [], sectors, peerGroups }
  const factsetCompanies: Record<string, CompanyFacts> = {}
  const overrideCompanies: Record<string, OverrideEntry> = {}
  const models: Record<string, OwnModel> = {}
  const seen = new Set<string>()
  let coverage: string | null = null

  const bucket = (tier: Tier, ticker: string): CompanyFacts => {
    const store =
      tier === 'factset'
        ? factsetCompanies
        : tier === 'override'
          ? overrideCompanies
          : models
    store[ticker] ??= tier === 'model' ? ({ ticker, series: {}, balance: {} } as OwnModel) : { series: {}, balance: {} }
    return store[ticker] as CompanyFacts
  }

  for (let row = 4; row <= DATA_LAST_ROW; row += 1) {
    const tickerCell = data.getCell(row, 1)
    const nameValue = data.getCell(row, 2).value
    const tickerText = stringValue(tickerCell)?.trim()
    if (!tickerText && (nameValue === null || nameValue === undefined)) continue

    if (nameValue === null || nameValue === undefined) {
      // A section header such as "Bhatia - Covered Companies".
      coverage = tickerText ?? coverage
      continue
    }
    const name = stringValue(data.getCell(row, 2))
    if (name === null) continue // month-name helper rows carry a number here
    if (!tickerText || seen.has(tickerText)) continue // VLOOKUP never reached repeats
    seen.add(tickerText)

    const covered = Boolean(
      coverage && coverage.includes('Covered') && !coverage.includes('Non-Covered'),
    )

    for (const [metric, [first, last]] of Object.entries(METRIC_BLOCKS) as [
      MetricKey,
      [number, number],
    ][]) {
      for (let col = first; col <= last; col += 1) {
        const year = yearFor(col)
        if (year === null) continue
        const cell = data.getCell(row, col)
        const value = numberValue(cell)
        if (value === null) continue
        const tier = classify(data, cell)
        const facts = bucket(tier, tickerText)
        facts.series ??= {}
        facts.series[metric] ??= {}
        facts.series[metric]![year] = value
      }
    }

    for (const [key, col] of Object.entries(BALANCE_COLUMNS) as [
      keyof typeof BALANCE_COLUMNS,
      number,
    ][]) {
      const cell = data.getCell(row, col)
      const value = numberValue(cell)
      if (value === null) continue
      const facts = bucket(classify(data, cell), tickerText)
      facts.balance ??= {}
      facts.balance[key] = value
    }

    const quote = prices[tickerText]
    if (typeof quote?.price === 'number') {
      bucket('factset', tickerText).price = quote.price
    }

    universe.companies.push({
      ticker: tickerText,
      name: name.trim(),
      fiscalYearEnd: numberValue(data.getCell(row, 3)),
      coverage,
      covered,
      sectors: sectorsByTicker.get(tickerText) ?? [],
      peerGroups: peersByTicker.get(tickerText) ?? [],
      ytdReturn: quote?.ytdReturn ?? null,
      priorYearReturn: quote?.priorYearReturn ?? null,
    })
  }

  // Mark every override cell as imported, matching the Python importer.
  for (const entry of Object.values(overrideCompanies)) {
    const imported: OverrideEntry['imported'] = {}
    for (const [metric, years] of Object.entries(entry.series ?? {})) {
      imported[metric as MetricKey] = Object.keys(years ?? {}).sort(
        (a, b) => Number(a) - Number(b),
      )
    }
    entry.imported = imported
    entry.importNote = importNote
  }

  return {
    universe,
    factset: {
      asOf: '',
      source: importNote,
      companies: factsetCompanies,
    },
    overrides: { companies: overrideCompanies },
    models,
  }
}

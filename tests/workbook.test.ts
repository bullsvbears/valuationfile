import { describe, expect, it } from 'vitest'

import { extractWorkbook } from '../src/workbook/extract.js'
import { buildTestWorkbook } from './fixtures/workbook.js'

/**
 * The in-app extractor against a synthetic workbook covering the real file's
 * awkward cases. Whole-file agreement with the Python extractor is checked
 * separately by scripts/verify-ts-extractor.ts against the original workbook.
 */
describe('extractWorkbook', () => {
  it('splits cells into tiers by formula text', async () => {
    const { universe, factset, overrides, models } = await extractWorkbook(
      await buildTestWorkbook(),
    )

    expect(universe.companies.map((c) => c.ticker)).toEqual(['AAAA', 'BBBB'])

    // AAAA: model link for 2025 revenue, FactSet pull for 2026, typed gross profit.
    expect(models.AAAA?.series?.revenue).toEqual({ '2025': 100 })
    expect(models.AAAA?.balance?.debt).toBe(5)
    expect(factset.companies.AAAA?.series?.revenue).toEqual({ '2026': 120 })
    expect(factset.companies.AAAA?.balance?.shares).toBe(50)
    expect(overrides.companies.AAAA?.series?.grossProfit).toEqual({ '2025': 80 })
    expect(overrides.companies.AAAA?.balance?.cash).toBe(10)
  })

  it('marks extracted overrides as imported so a clear keeps them', async () => {
    const { overrides } = await extractWorkbook(await buildTestWorkbook(), 'test import')
    expect(overrides.companies.AAAA?.imported).toEqual({ grossProfit: ['2025'] })
    expect(overrides.companies.AAAA?.importNote).toBe('test import')
  })

  it('keeps a cached formula result of 0, which exceljs hides', async () => {
    const { universe, factset } = await extractWorkbook(await buildTestWorkbook())
    // Both a zero revenue estimate and a flat cached YTD return survive.
    expect(factset.companies.BBBB?.series?.revenue).toEqual({ '2025': 0 })
    expect(universe.companies.find((c) => c.ticker === 'BBBB')?.ytdReturn).toBe(0)
  })

  it('carries coverage sections and skips duplicate and month rows', async () => {
    const { universe } = await extractWorkbook(await buildTestWorkbook())
    const [aaaa, bbbb] = universe.companies
    expect(aaaa).toMatchObject({
      coverage: 'Bhatia - Covered Companies',
      covered: true,
      name: 'Alpha Corp',
    })
    expect(bbbb).toMatchObject({ coverage: 'Non-Covered Companies', covered: false })
  })

  it('reads prices and returns from the Master Software sheet', async () => {
    const { universe, factset } = await extractWorkbook(await buildTestWorkbook())
    expect(factset.companies.AAAA?.price).toBe(55.5)
    expect(factset.companies.BBBB?.price).toBe(20)
    const aaaa = universe.companies.find((c) => c.ticker === 'AAAA')
    expect(aaaa?.ytdReturn).toBe(0.1)
    expect(aaaa?.priorYearReturn).toBe(-0.2)
  })

  it('reads group sheets, merged headers included, and skips stat rows', async () => {
    const { universe } = await extractWorkbook(await buildTestWorkbook())
    expect(universe.sectors).toEqual({
      Infrastructure: ['AAAA'],
      'Merged Group': ['BBBB'],
    })
    expect(universe.peerGroups).toEqual({ 'High Growth': ['AAAA'] })
    expect(universe.companies[1]?.sectors).toEqual(['Merged Group'])
  })

  it('rejects a file without a Data sheet', async () => {
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    wb.addWorksheet('Something Else')
    const buffer = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer)
    await expect(extractWorkbook(buffer)).rejects.toThrow(/no "Data" sheet/)
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { DataStore } from '../src/lib/store.js'
import type { OverrideStore } from '../src/lib/types.js'

/** Persistence behaviour, exercised against a throwaway data directory. */

let dir: string
let store: DataStore

const seededUniverse = {
  companies: [
    { ticker: 'ADBE', name: 'Adobe', fiscalYearEnd: 11, coverage: null, covered: false, sectors: ['Front Office'], peerGroups: ['Software Group'] },
    { ticker: 'CRM', name: 'Salesforce', fiscalYearEnd: 1, coverage: null, covered: false, sectors: ['Front Office'], peerGroups: [] },
    { ticker: 'NOW', name: 'ServiceNow', fiscalYearEnd: 12, coverage: null, covered: false, sectors: [], peerGroups: [] },
  ],
  sectors: { 'Front Office': ['ADBE', 'CRM'] },
  peerGroups: { 'Software Group': ['ADBE'] },
}

const seeded: OverrideStore = {
  companies: {
    ADBE: {
      series: {
        revenue: { '2023': 19409, '2024': 21505 },
        fcf: { '2024': 7873 },
      },
      imported: { revenue: ['2023', '2024'], fcf: ['2024'] },
      importNote: 'Hard-coded cell imported from the workbook',
    },
  },
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'valuation-store-'))
  mkdirSync(path.join(dir, 'models'))
  writeFileSync(path.join(dir, 'overrides.json'), JSON.stringify(seeded))
  writeFileSync(path.join(dir, 'universe.json'), JSON.stringify(seededUniverse))
  store = new DataStore(dir)
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('override persistence', () => {
  it('merges a patch into the existing overrides', async () => {
    await store.patchOverride('ADBE', { series: { revenue: { '2027': 31000 } } })
    const saved = (await store.loadOverrides()).companies.ADBE
    expect(saved?.series?.revenue).toMatchObject({ '2024': 21505, '2027': 31000 })
  })

  it('clears a cell when the patch carries an explicit null', async () => {
    await store.patchOverride('ADBE', { series: { revenue: { '2024': null } } })
    const saved = (await store.loadOverrides()).companies.ADBE
    expect(saved?.series?.revenue).not.toHaveProperty('2024')
    expect(saved?.series?.revenue).toHaveProperty('2023')
  })

  it('keeps imported actuals when the analyst clears their own overrides', async () => {
    // The reported actuals carried in from the workbook are history, not edits,
    // so clearing overrides must not take them with it.
    await store.patchOverride('ADBE', { series: { revenue: { '2027': 31000 } } })
    await store.clearOverrides('ADBE')

    const saved = (await store.loadOverrides()).companies.ADBE
    expect(saved?.series?.revenue).toEqual({ '2023': 19409, '2024': 21505 })
    expect(saved?.series?.fcf).toEqual({ '2024': 7873 })
  })

  it('removes the company entirely when imported cells are cleared too', async () => {
    await store.clearOverrides('ADBE', true)
    expect((await store.loadOverrides()).companies.ADBE).toBeUndefined()
  })

  it('counts only the overrides entered by the analyst', async () => {
    const before = await store.loadOverrides()
    expect(DataStore.analystOverrideCount(before.companies.ADBE)).toBe(0)

    await store.patchOverride('ADBE', { series: { revenue: { '2027': 31000 } } })
    const after = await store.loadOverrides()
    expect(DataStore.analystOverrideCount(after.companies.ADBE)).toBe(1)
  })

  it('drops the entry when a company has nothing left to keep', async () => {
    await store.patchOverride('CRM', { series: { revenue: { '2027': 100 } } })
    await store.clearOverrides('CRM')
    expect((await store.loadOverrides()).companies.CRM).toBeUndefined()
  })

  it('lets a live price update supersede a stale manual price', async () => {
    // A hand-typed price is a stopgap while the feed cannot reach a name;
    // once the feed prices it, the manual value must not shadow it forever.
    await store.patchOverride('ADBE', { price: 999 })
    await store.patchOverride('CRM', { price: 111 })

    await store.updatePrices({ ADBE: 300 })

    const overrides = await store.loadOverrides()
    expect(overrides.companies.ADBE?.price).toBeUndefined() // superseded
    expect(overrides.companies.CRM?.price).toBe(111) // not priced: kept
    expect((await store.loadFactSet()).companies.ADBE?.price).toBe(300)
  })
})

describe('model persistence', () => {
  it('round-trips a model and stamps it with a save time', async () => {
    await store.saveModel({
      ticker: 'CRM',
      series: { revenue: { '2027': 49947 } },
      thesis: 'Margin expansion holds',
    })
    const models = await store.loadModels()
    expect(models.CRM?.series?.revenue?.['2027']).toBe(49947)
    expect(models.CRM?.thesis).toBe('Margin expansion holds')
    expect(models.CRM?.updatedAt).toBeTruthy()
  })

  it('keeps each company in its own file so saves cannot collide', async () => {
    await store.saveModel({ ticker: 'CRM', series: {} })
    await store.saveModel({ ticker: 'ADBE', series: {} })
    expect(Object.keys(await store.loadModels()).sort()).toEqual(['ADBE', 'CRM'])
  })

  it('writes atomically, leaving no temp file behind', async () => {
    await store.saveModel({ ticker: 'CRM', series: {} })
    expect(() => readFileSync(path.join(dir, 'models', 'CRM.json.tmp'))).toThrow()
  })
})

describe('comp group editing', () => {
  it('adds a member and keeps both membership directions in sync', async () => {
    const members = await store.updateGroup('sector', 'Front Office', { add: ['NOW'] })
    expect(members).toEqual(['ADBE', 'CRM', 'NOW'])

    const universe = await store.loadUniverse()
    expect(universe.sectors['Front Office']).toContain('NOW')
    expect(universe.companies.find((c) => c.ticker === 'NOW')?.sectors).toContain('Front Office')
  })

  it('removes a member from both directions', async () => {
    await store.updateGroup('sector', 'Front Office', { remove: ['CRM'] })
    const universe = await store.loadUniverse()
    expect(universe.sectors['Front Office']).toEqual(['ADBE'])
    expect(universe.companies.find((c) => c.ticker === 'CRM')?.sectors).toEqual([])
  })

  it('normalises case and whitespace on the way in', async () => {
    const members = await store.updateGroup('financial', 'Software Group', { add: [' crm '] })
    expect(members).toEqual(['ADBE', 'CRM'])
  })

  it('rejects a ticker outside the universe rather than dropping it silently', async () => {
    // A typo that vanishes reads as a successful add; it must fail loudly.
    await expect(
      store.updateGroup('sector', 'Front Office', { add: ['NOPE'] }),
    ).rejects.toThrow('Unknown ticker')
  })

  it('creates a group on first add but refuses to remove from a group that never existed', async () => {
    const members = await store.updateGroup('financial', 'My Watchlist', { add: ['ADBE', 'NOW'] })
    expect(members).toEqual(['ADBE', 'NOW'])
    const universe = await store.loadUniverse()
    expect(universe.companies.find((c) => c.ticker === 'NOW')?.peerGroups).toContain('My Watchlist')

    await expect(
      store.updateGroup('sector', 'No Such Group', { remove: ['ADBE'] }),
    ).rejects.toThrow('Unknown group')
  })

  it('does not duplicate a member added twice', async () => {
    await store.updateGroup('sector', 'Front Office', { add: ['ADBE'] })
    const universe = await store.loadUniverse()
    expect(universe.sectors['Front Office']).toEqual(['ADBE', 'CRM'])
    expect(universe.companies.find((c) => c.ticker === 'ADBE')?.sectors).toEqual(['Front Office'])
  })

  it('records every membership change in the audit log', async () => {
    await store.updateGroup('sector', 'Front Office', { add: ['NOW'], remove: ['CRM'] })
    await store.updateGroup('financial', 'My Watchlist', { add: ['ADBE'] })
    // A no-op edit (already a member) must not clutter the log.
    await store.updateGroup('sector', 'Front Office', { add: ['ADBE'] })

    const log = await store.loadGroupAudit()
    expect(log.entries).toHaveLength(2)
    expect(log.entries[0]).toMatchObject({
      kind: 'sector',
      group: 'Front Office',
      added: ['NOW'],
      removed: ['CRM'],
    })
    expect(log.entries[0]?.created).toBeUndefined()
    expect(log.entries[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(log.entries[1]).toMatchObject({
      kind: 'financial',
      group: 'My Watchlist',
      added: ['ADBE'],
      removed: [],
      created: true,
    })
  })
})

describe('adding a company', () => {
  it('adds identity only, normalised, and refuses duplicates and junk', async () => {
    const meta = await store.addCompany({
      ticker: ' newco ',
      name: '  NewCo, Inc. ',
      fiscalYearEnd: 1,
      covered: true,
    })
    expect(meta).toMatchObject({
      ticker: 'NEWCO',
      name: 'NewCo, Inc.',
      fiscalYearEnd: 1,
      covered: true,
      coverage: 'Bhatia - Covered Companies',
      sectors: [],
      peerGroups: [],
    })

    const universe = await store.loadUniverse()
    expect(universe.companies.map((c) => c.ticker)).toContain('NEWCO')

    // The new name is immediately usable everywhere tickers are validated.
    await store.updateGroup('sector', 'Front Office', { add: ['NEWCO'] })

    await expect(
      store.addCompany({ ticker: 'newco', name: 'Again', fiscalYearEnd: 12, covered: false }),
    ).rejects.toThrow('already in the universe')
    await expect(
      store.addCompany({ ticker: 'BAD TICKER', name: 'X', fiscalYearEnd: 12, covered: false }),
    ).rejects.toThrow('not a usable ticker')
    await expect(
      store.addCompany({ ticker: 'OK', name: '  ', fiscalYearEnd: 12, covered: false }),
    ).rejects.toThrow('needs a name')
    await expect(
      store.addCompany({ ticker: 'OK', name: 'X', fiscalYearEnd: 13, covered: false }),
    ).rejects.toThrow('month')
  })

  it('marks a non-covered add as such', async () => {
    const meta = await store.addCompany({
      ticker: 'PLAIN',
      name: 'Plain Co',
      fiscalYearEnd: 12,
      covered: false,
    })
    expect(meta.covered).toBe(false)
    expect(meta.coverage).toBe('Non-Covered Companies')
  })
})

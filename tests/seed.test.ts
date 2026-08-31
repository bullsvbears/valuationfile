import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { seedDataDir } from '../server/seed.js'

describe('data directory seeding', () => {
  let bundled: string
  let dataDir: string

  beforeEach(() => {
    bundled = mkdtempSync(path.join(tmpdir(), 'seed-bundled-'))
    dataDir = mkdtempSync(path.join(tmpdir(), 'seed-data-'))
    writeFileSync(path.join(bundled, 'universe.json'), '{"companies":[]}')
    writeFileSync(path.join(bundled, 'kpis.json'), '{"MNDY":{}}')
    mkdirSync(path.join(bundled, 'models'))
    writeFileSync(path.join(bundled, 'models', 'ADBE.json'), '{"ticker":"ADBE"}')
  })

  afterEach(() => {
    rmSync(bundled, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('fills an empty volume completely', async () => {
    expect(await seedDataDir(dataDir, bundled)).toBe('seeded')
    expect(readFileSync(path.join(dataDir, 'kpis.json'), 'utf8')).toBe('{"MNDY":{}}')
    expect(readFileSync(path.join(dataDir, 'models', 'ADBE.json'), 'utf8')).toContain('ADBE')
  })

  it('backfills files a volume seeded by an older image is missing', async () => {
    // A volume from before kpis.json shipped: universe present and edited.
    writeFileSync(path.join(dataDir, 'universe.json'), '{"companies":["edited"]}')

    const result = await seedDataDir(dataDir, bundled)
    expect(result).not.toBe('seeded')
    const backfilled = (result as { backfilled: string[] }).backfilled
    expect(backfilled).toContain('kpis.json')
    expect(backfilled.some((f) => f.startsWith('models'))).toBe(true)

    // The missing file arrived; the analyst's edit was not overwritten.
    expect(readFileSync(path.join(dataDir, 'kpis.json'), 'utf8')).toBe('{"MNDY":{}}')
    expect(readFileSync(path.join(dataDir, 'universe.json'), 'utf8')).toBe(
      '{"companies":["edited"]}',
    )
  })

  it('backfills a single missing file inside an existing directory', async () => {
    writeFileSync(path.join(dataDir, 'universe.json'), '{}')
    mkdirSync(path.join(dataDir, 'models'))
    writeFileSync(path.join(dataDir, 'models', 'CRM.json'), '{"ticker":"CRM","edited":true}')

    const result = await seedDataDir(dataDir, bundled)
    const backfilled = (result as { backfilled: string[] }).backfilled
    expect(backfilled).toContain(path.join('models', 'ADBE.json'))
    expect(readFileSync(path.join(dataDir, 'models', 'CRM.json'), 'utf8')).toContain('edited')
  })

  it('reports nothing to do when the volume is complete', async () => {
    await seedDataDir(dataDir, bundled)
    const again = await seedDataDir(dataDir, bundled)
    expect((again as { backfilled: string[] }).backfilled).toEqual([])
  })
})

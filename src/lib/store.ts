import { readFile, writeFile, readdir, mkdir, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

import type {
  CompanyMeta,
  FactSetCache,
  OverrideEntry,
  OverrideStore,
  OwnModel,
} from './types.js'

/**
 * File-backed persistence for the three data tiers.
 *
 * Each tier is a plain JSON file so it stays greppable and diffable in git:
 * an override or a change to a model shows up in a commit as a readable line,
 * which is the audit trail the linked-workbook setup could not offer.
 */

export interface Universe {
  companies: (CompanyMeta & { ytdReturn?: number | null; priorYearReturn?: number | null })[]
  sectors: Record<string, string[]>
  peerGroups: Record<string, string[]>
}

export class DataStore {
  constructor(private readonly root: string) {}

  private file(name: string): string {
    return path.join(this.root, name)
  }

  private async readJson<T>(name: string, fallback: T): Promise<T> {
    const target = this.file(name)
    if (!existsSync(target)) return fallback
    return JSON.parse(await readFile(target, 'utf8')) as T
  }

  /** Write via a temp file and rename, so a crash mid-write cannot truncate a tier. */
  private async writeJson(name: string, payload: unknown): Promise<void> {
    const target = this.file(name)
    await mkdir(path.dirname(target), { recursive: true })
    const temp = `${target}.tmp`
    await writeFile(temp, JSON.stringify(payload, null, 1) + '\n', 'utf8')
    await rename(temp, target)
  }

  loadUniverse(): Promise<Universe> {
    return this.readJson<Universe>('universe.json', {
      companies: [],
      sectors: {},
      peerGroups: {},
    })
  }

  loadFactSet(): Promise<FactSetCache> {
    return this.readJson<FactSetCache>('factset-cache.json', {
      asOf: '',
      source: 'empty',
      companies: {},
    })
  }

  saveFactSet(cache: FactSetCache): Promise<void> {
    return this.writeJson('factset-cache.json', cache)
  }

  loadOverrides(): Promise<OverrideStore> {
    return this.readJson<OverrideStore>('overrides.json', { companies: {} })
  }

  saveOverrides(store: OverrideStore): Promise<void> {
    return this.writeJson('overrides.json', store)
  }

  /** Own models live one file per ticker, so two names never collide on save. */
  async loadModels(): Promise<Record<string, OwnModel>> {
    const dir = this.file('models')
    if (!existsSync(dir)) return {}
    const models: Record<string, OwnModel> = {}
    for (const entry of await readdir(dir)) {
      if (!entry.endsWith('.json')) continue
      const model = JSON.parse(await readFile(path.join(dir, entry), 'utf8')) as OwnModel
      models[model.ticker ?? entry.replace(/\.json$/, '')] = model
    }
    return models
  }

  saveModel(model: OwnModel): Promise<void> {
    return this.writeJson(
      path.join('models', `${model.ticker}.json`),
      { ...model, updatedAt: new Date().toISOString() },
    )
  }

  /**
   * Merge a patch into one company's overrides.
   *
   * A `null` in the patch clears the override and lets the cell fall back to the
   * model or FactSet tier, which is how an analyst undoes an edit without having
   * to remember what the underlying vendor number was.
   */
  async patchOverride(ticker: string, patch: OverrideEntry): Promise<OverrideEntry> {
    const store = await this.loadOverrides()
    const current = store.companies[ticker] ?? { series: {}, balance: {} }

    const series = { ...current.series }
    for (const [metric, years] of Object.entries(patch.series ?? {})) {
      const merged = { ...(series as Record<string, Record<string, number | null>>)[metric] }
      for (const [year, value] of Object.entries(years ?? {})) {
        if (value === null) delete merged[year]
        else merged[year] = value as number
      }
      ;(series as Record<string, unknown>)[metric] = merged
    }

    const balance = { ...current.balance }
    for (const [key, value] of Object.entries(patch.balance ?? {})) {
      if (value === null) delete (balance as Record<string, unknown>)[key]
      else (balance as Record<string, unknown>)[key] = value
    }

    const next: OverrideEntry = {
      ...current,
      series,
      balance,
      price: patch.price === null ? undefined : (patch.price ?? current.price),
      notes: { ...current.notes, ...patch.notes },
      updatedAt: new Date().toISOString(),
    }

    store.companies[ticker] = next
    await this.saveOverrides(store)
    return next
  }

  async clearOverrides(ticker: string): Promise<void> {
    const store = await this.loadOverrides()
    delete store.companies[ticker]
    await this.saveOverrides(store)
  }
}

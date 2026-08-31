import { readFile, writeFile, readdir, mkdir, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

import type {
  CompanyMeta,
  FactSetCache,
  MetricKey,
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

/** A saved screener view: name plus the filter state to restore. */
export interface SavedView {
  name: string
  search?: string
  group?: string
  coverageOnly?: boolean
  year?: string
  sort?: { key: string; direction: 1 | -1 }
  filters?: { key: string; op: 'gte' | 'lte'; value: number }[]
}

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

  /**
   * Write fresh closes into the FactSet tier, leaving estimates untouched.
   * `pricesAsOf` is stamped separately from `asOf`: prices from the free feed
   * do not make the estimates any less stale, and the UI says so.
   */
  async updatePrices(prices: Record<string, number>): Promise<number> {
    const cache = await this.loadFactSet()
    let updated = 0
    for (const [ticker, price] of Object.entries(prices)) {
      const entry = cache.companies[ticker] ?? { series: {} }
      entry.price = price
      cache.companies[ticker] = entry
      updated += 1
    }
    cache.pricesAsOf = new Date().toISOString()
    await this.saveFactSet(cache)
    return updated
  }

  /** Store the prior-year closing prices that year-to-date returns divide by. */
  async updatePriorYearCloses(
    closes: Record<string, number>,
    year: number,
  ): Promise<number> {
    const cache = await this.loadFactSet()
    for (const [ticker, close] of Object.entries(closes)) {
      const entry = cache.companies[ticker] ?? { series: {} }
      entry.priorYearClose = close
      cache.companies[ticker] = entry
    }
    cache.priorYearCloseYear = year
    await this.saveFactSet(cache)
    return Object.keys(closes).length
  }

  loadOverrides(): Promise<OverrideStore> {
    return this.readJson<OverrideStore>('overrides.json', { companies: {} })
  }

  saveOverrides(store: OverrideStore): Promise<void> {
    return this.writeJson('overrides.json', store)
  }

  /** Operating KPIs imported from the workbook, keyed ticker -> kpi -> year. */
  loadKpis(): Promise<Record<string, Record<string, Record<string, number>>>> {
    return this.readJson('kpis.json', {})
  }

  /** Saved screener views: small, named bundles of filter state. */
  loadViews(): Promise<{ views: SavedView[] }> {
    return this.readJson('views.json', { views: [] })
  }

  async saveView(view: SavedView): Promise<SavedView[]> {
    const store = await this.loadViews()
    const others = store.views.filter((v) => v.name !== view.name)
    const views = [...others, view].sort((a, b) => a.name.localeCompare(b.name))
    await this.writeJson('views.json', { views })
    return views
  }

  async deleteView(name: string): Promise<SavedView[]> {
    const store = await this.loadViews()
    const views = store.views.filter((v) => v.name !== name)
    await this.writeJson('views.json', { views })
    return views
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

  /**
   * Drop the overrides an analyst entered here, keeping the cells carried over
   * from the source workbook.
   *
   * Those imported cells are almost all reported actuals, so wiping them would
   * silently delete history the analyst never chose to override. Pass
   * `includeImported` to clear them too.
   */
  async clearOverrides(ticker: string, includeImported = false): Promise<void> {
    const store = await this.loadOverrides()
    const current = store.companies[ticker]
    if (!current) return

    if (includeImported || !current.imported) {
      delete store.companies[ticker]
      await this.saveOverrides(store)
      return
    }

    const series: Record<string, Record<string, number | null>> = {}
    for (const [metric, years] of Object.entries(current.series ?? {})) {
      const keep = new Set(current.imported[metric as MetricKey] ?? [])
      const kept: Record<string, number | null> = {}
      for (const [year, value] of Object.entries(years ?? {})) {
        if (keep.has(year) && value !== undefined) kept[year] = value
      }
      if (Object.keys(kept).length) series[metric] = kept
    }

    if (!Object.keys(series).length) delete store.companies[ticker]
    else store.companies[ticker] = { ...current, series, updatedAt: new Date().toISOString() }

    await this.saveOverrides(store)
  }

  /**
   * Add or remove members of a comp group, keeping both directions in sync.
   *
   * Membership is stored twice — the group's ticker list, and each company's
   * list of groups — because reads want both shapes. This is the one writer,
   * so the two can never drift. Adding to a group that does not exist creates
   * it; unknown tickers are rejected rather than silently dropped, since a
   * typo that vanishes reads as a successful add.
   */
  async updateGroup(
    kind: 'sector' | 'financial',
    group: string,
    changes: { add?: string[]; remove?: string[] },
  ): Promise<string[]> {
    const universe = await this.loadUniverse()
    const mapping = kind === 'sector' ? universe.sectors : universe.peerGroups

    const known = new Map(universe.companies.map((c) => [c.ticker.toUpperCase(), c.ticker]))
    const normalise = (raw: string): string => {
      const ticker = known.get(raw.trim().toUpperCase())
      if (!ticker) throw new Error(`Unknown ticker "${raw.trim()}"`)
      return ticker
    }

    const add = (changes.add ?? []).filter((t) => t.trim()).map(normalise)
    const remove = new Set((changes.remove ?? []).filter((t) => t.trim()).map(normalise))
    if (!(group in mapping) && !add.length) throw new Error(`Unknown group "${group}"`)

    const current = mapping[group] ?? []
    const next = current.filter((t) => !remove.has(t))
    for (const ticker of add) if (!next.includes(ticker)) next.push(ticker)
    mapping[group] = next

    const field = kind === 'sector' ? 'sectors' : 'peerGroups'
    const members = new Set(next)
    for (const company of universe.companies) {
      const inGroup = members.has(company.ticker)
      const listed = company[field].includes(group)
      if (inGroup && !listed) company[field] = [...company[field], group]
      else if (!inGroup && listed) company[field] = company[field].filter((g) => g !== group)
    }

    await this.writeJson('universe.json', universe)
    return next
  }

  /** Count of override cells an analyst entered here, ignoring imported ones. */
  static analystOverrideCount(entry: OverrideEntry | undefined): number {
    if (!entry) return 0
    let count = 0
    for (const [metric, years] of Object.entries(entry.series ?? {})) {
      const imported = new Set(entry.imported?.[metric as MetricKey] ?? [])
      for (const year of Object.keys(years ?? {})) {
        if (!imported.has(year)) count += 1
      }
    }
    return count
  }
}

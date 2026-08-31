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

/** One comp-group membership change, as recorded in the audit log. */
export interface GroupAuditEntry {
  at: string
  kind: 'sector' | 'financial'
  group: string
  added: string[]
  removed: string[]
  /** Set when this edit brought the group into existence. */
  created?: boolean
}

export interface GroupAuditLog {
  entries: GroupAuditEntry[]
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

    // A hand-typed price is a stopgap for a name the feed cannot reach, not
    // a permanent pin: the moment a live source prices the ticker, the stale
    // manual price would silently freeze market cap, EV and every multiple.
    // Clear price overrides for everything this update actually priced;
    // manual prices for unpriced names (private companies, unmapped
    // listings) survive untouched, as do all other overrides.
    const overrides = await this.loadOverrides()
    let cleared = false
    for (const ticker of Object.keys(prices)) {
      const entry = overrides.companies[ticker]
      if (entry && typeof entry.price === 'number') {
        delete entry.price
        cleared = true
      }
    }
    if (cleared) await this.saveOverrides(overrides)

    return updated
  }

  /** Store the prior-year closing prices that year-to-date returns divide by. */
  async updatePriorYearCloses(
    closes: Record<string, number>,
    year: number,
  ): Promise<number> {
    const cache = await this.loadFactSet()
    // A new year invalidates every stored baseline: without this, a name the
    // feed cannot price would keep last year's close under this year's stamp
    // and its YTD would silently measure from the wrong date.
    if (cache.priorYearCloseYear !== undefined && cache.priorYearCloseYear !== year) {
      for (const entry of Object.values(cache.companies)) delete entry.priorYearClose
    }
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
      priorYearClose:
        patch.priorYearClose === null
          ? undefined
          : (patch.priorYearClose ?? current.priorYearClose),
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

    const existed = group in mapping
    const current = mapping[group] ?? []
    const next = current.filter((t) => !remove.has(t))
    const added = add.filter((t) => !next.includes(t))
    next.push(...added)
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

    // Every membership change leaves an audit entry, so a stat that moved can
    // be traced to the roster edit that moved it.
    const removed = current.filter((t) => remove.has(t))
    if (added.length || removed.length) {
      const log = await this.loadGroupAudit()
      log.entries.push({
        at: new Date().toISOString(),
        kind,
        group,
        added,
        removed,
        ...(existed ? {} : { created: true }),
      })
      // The log is a working record, not an archive; keep it bounded.
      if (log.entries.length > 1000) log.entries = log.entries.slice(-1000)
      await this.writeJson('group-audit.json', log)
    }
    return next
  }

  /** The comp-group membership audit log, oldest entry first. */
  loadGroupAudit(): Promise<GroupAuditLog> {
    return this.readJson<GroupAuditLog>('group-audit.json', { entries: [] })
  }

  /**
   * Add a brand-new company to the universe.
   *
   * Only the identity is set here: estimates and balance-sheet inputs are
   * typed into Master Input afterwards (or arrive with the next FactSet
   * refresh), the price comes with the next price update, and comp-group
   * membership is assigned on the peers tabs.
   */
  async addCompany(input: {
    ticker: string
    name: string
    fiscalYearEnd: number
    covered: boolean
  }): Promise<CompanyMeta> {
    const ticker = input.ticker.trim().toUpperCase()
    const name = input.name.trim()
    if (!/^[A-Z0-9.-]{1,12}$/.test(ticker)) {
      throw new Error(`"${input.ticker}" is not a usable ticker (letters, digits, . or -)`)
    }
    if (!name) throw new Error('The company needs a name')
    if (!Number.isInteger(input.fiscalYearEnd) || input.fiscalYearEnd < 1 || input.fiscalYearEnd > 12) {
      throw new Error('Fiscal year end must be a month, 1-12')
    }

    const universe = await this.loadUniverse()
    if (universe.companies.some((c) => c.ticker.toUpperCase() === ticker)) {
      throw new Error(`${ticker} is already in the universe`)
    }

    const meta: CompanyMeta = {
      ticker,
      name,
      fiscalYearEnd: input.fiscalYearEnd,
      coverage: input.covered ? 'Bhatia - Covered Companies' : 'Non-Covered Companies',
      covered: input.covered,
      sectors: [],
      peerGroups: [],
    }
    universe.companies.push(meta)
    await this.writeJson('universe.json', universe)
    return meta
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

import type { Dashboard } from '../lib/dashboard.js'
import type { CompanyView } from '../lib/dashboard.js'
import type { CompanyFacts, OverrideEntry, OwnModel } from '../lib/types.js'
import type { SavedView } from '../lib/store.js'

export type { SavedView }

/** Thin fetch wrappers over the dashboard API. */

/** Thrown when the API reports no valid session, so the UI can show the login. */
export class NotSignedInError extends Error {
  constructor() {
    super('Not signed in')
    this.name = 'NotSignedInError'
  }
}

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (res.status === 401) throw new NotSignedInError()
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `${res.status} ${res.statusText}`)
  }
  return (await res.json()) as T
}

export interface CompanyDetail extends CompanyView {
  /** Operating KPIs imported from the workbook, kpi -> year -> value. */
  kpis: Record<string, Record<string, number>> | null
  tiers: {
    factset: CompanyFacts | null
    model: OwnModel | null
    override: OverrideEntry | null
  }
}

export interface SessionState {
  authRequired: boolean
  signedIn: boolean
}

export interface HistorySnapshot {
  date: string
  takenAt: string
  companies: Record<string, {
    price: number | null
    shares: number | null
    cash: number | null
    debt: number | null
    series: Partial<Record<string, Record<string, number>>>
    factset?: { price: number | null; series: Partial<Record<string, Record<string, number>>> }
    multiples?: Record<string, Partial<Record<string, number>>>
  }>
}

export const api = {
  session: () => json<SessionState>('/api/session'),

  historyDates: () => json<{ dates: string[] }>('/api/history'),

  historySeries: (ticker: string, metric: string, year: string) =>
    json<{
      points: {
        date: string
        price: number | null
        resolved: number | null
        factset: number | null
        evRevenue: number | null
      }[]
    }>(
      `/api/history/series?ticker=${encodeURIComponent(ticker)}&metric=${encodeURIComponent(metric)}&year=${encodeURIComponent(year)}`,
    ),

  views: () => json<{ views: SavedView[] }>('/api/views'),

  saveView: (view: SavedView) =>
    json<{ views: SavedView[] }>('/api/views', { method: 'PUT', body: JSON.stringify(view) }),

  deleteView: (name: string) =>
    json<{ views: SavedView[] }>(`/api/views/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  updateGroup: (
    kind: 'sector' | 'financial',
    group: string,
    changes: { add?: string[]; remove?: string[] },
  ) =>
    json<{ ok: boolean; group: string; members: string[] }>('/api/groups', {
      method: 'PATCH',
      body: JSON.stringify({ kind, group, ...changes }),
    }),

  historySnapshot: (date: string) =>
    json<HistorySnapshot>(`/api/history/${encodeURIComponent(date)}`),

  logout: () => json<{ ok: boolean }>('/api/logout', { method: 'POST' }),

  dashboard: (year?: string) =>
    json<Dashboard>(`/api/dashboard${year ? `?year=${encodeURIComponent(year)}` : ''}`),

  company: (ticker: string) => json<CompanyDetail>(`/api/company/${ticker}`),

  saveOverride: (ticker: string, patch: OverrideEntry) =>
    json<OverrideEntry>(`/api/company/${ticker}/override`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  clearOverrides: (ticker: string) =>
    json<{ ok: boolean }>(`/api/company/${ticker}/override`, { method: 'DELETE' }),

  saveModel: (ticker: string, model: OwnModel) =>
    json<OwnModel>(`/api/company/${ticker}/model`, {
      method: 'PUT',
      body: JSON.stringify(model),
    }),

  /** Turn an uploaded old workbook into the history snapshot for a past date. */
  backfill: async (date: string, file: File) => {
    const res = await fetch(`/api/backfill?date=${encodeURIComponent(date)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: await file.arrayBuffer(),
    })
    if (res.status === 401) throw new NotSignedInError()
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error ?? `${res.status} ${res.statusText}`)
    }
    return (await res.json()) as { ok: boolean; date: string; companies: number }
  },

  /** Full FactSet pull: estimates, prices, balance sheet. Needs credentials. */
  refresh: () =>
    json<{ ok: boolean; mode: 'factset'; asOf: string; companies: number }>('/api/refresh', {
      method: 'POST',
    }),

  /** Prices only: FactSet when configured, the free EOD feed otherwise. */
  refreshPrices: () =>
    json<{
      ok: boolean
      mode: 'prices'
      source: 'factset' | 'stooq'
      updated: number
      unpriced: string[]
      unmapped: string[]
      yearEndCloses: number
    }>('/api/refresh-prices', { method: 'POST' }),
}

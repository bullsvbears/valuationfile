import type { Dashboard } from '../lib/dashboard.js'
import type { CompanyView } from '../lib/dashboard.js'
import type { CompanyFacts, OverrideEntry, OwnModel } from '../lib/types.js'

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

  refresh: () => json<{ ok: boolean; asOf: string; companies: number }>('/api/refresh', {
    method: 'POST',
  }),
}

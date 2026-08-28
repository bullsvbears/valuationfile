import type { Dashboard } from '../lib/dashboard.js'
import type { CompanyView } from '../lib/dashboard.js'
import type { CompanyFacts, OverrideEntry, OwnModel } from '../lib/types.js'

/** Thin fetch wrappers over the dashboard API. */

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
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

export const api = {
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

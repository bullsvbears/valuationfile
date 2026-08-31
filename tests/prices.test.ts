import { describe, expect, it } from 'vitest'
import {
  fetchPolygonPrices,
  fetchYearEndCloses,
  polygonSymbol,
} from '../src/prices/polygon.js'

/** A grouped-daily payload with just the fields the client reads. */
function grouped(closes: Record<string, number>) {
  return {
    status: 'OK',
    resultsCount: Object.keys(closes).length,
    results: Object.entries(closes).map(([T, c]) => ({ T, c })),
  }
}

const empty = { status: 'OK', resultsCount: 0, results: [] }

/** A fetch stub that answers per grouped-daily date and records requests. */
function fakePolygon(byDate: (date: string) => unknown) {
  const dates: string[] = []
  const fetchImpl = (async (url: string) => {
    const date = new URL(url).pathname.split('/').pop()!
    dates.push(date)
    const body = byDate(date)
    if (body instanceof Response) return body
    return new Response(JSON.stringify(body))
  }) as typeof fetch
  return { fetchImpl, dates }
}

describe('symbol mapping', () => {
  it('passes plain US tickers through and refuses the rest', () => {
    expect(polygonSymbol('ADBE')).toBe('ADBE')
    expect(polygonSymbol('U')).toBe('U')
    // Foreign listings carry venue suffixes and trade in other currencies;
    // SPCX is private. All keep their FactSet or hand-entered price.
    for (const t of ['763-HK', 'CSU-CA', '005930-KR', '532540-IN', 'VSURE-OME', 'SPCX']) {
      expect(polygonSymbol(t)).toBeNull()
    }
  })
})

describe('fetchPolygonPrices', () => {
  it('prices the universe from one grouped-daily session', async () => {
    const { fetchImpl, dates } = fakePolygon(() => grouped({ ADBE: 293.55, CRM: 259.39 }))
    const result = await fetchPolygonPrices(['ADBE', 'CRM', 'DELISTED', 'SPCX'], {
      apiKey: 'k',
      fetchImpl,
    })
    expect(result.prices).toEqual({ ADBE: 293.55, CRM: 259.39 })
    expect(result.unpriced).toEqual(['DELISTED'])
    expect(result.unmapped).toEqual(['SPCX'])
    expect(dates).toHaveLength(1) // the whole universe cost one call
    expect(result.sessionDate).toBe(dates[0]) // the session the closes belong to
  })

  it('walks back past days with no session to the last completed one', async () => {
    const { fetchImpl, dates } = fakePolygon((date) =>
      // Only the second-newest weekday has a file — a holiday Monday, say.
      dates.length <= 1 ? empty : grouped({ ADBE: 100 }),
    )
    const result = await fetchPolygonPrices(['ADBE'], { apiKey: 'k', fetchImpl })
    expect(result.prices).toEqual({ ADBE: 100 })
    expect(dates.length).toBeGreaterThan(1)
    for (const d of dates) {
      const weekday = new Date(`${d}T12:00:00Z`).getUTCDay()
      expect(weekday).not.toBe(0) // weekends are skipped without a request
      expect(weekday).not.toBe(6)
    }
  })

  it('names the API key as the problem on a 401/403', async () => {
    const { fetchImpl } = fakePolygon(
      () => new Response(JSON.stringify({ message: 'Unknown API Key' }), { status: 401 }),
    )
    await expect(fetchPolygonPrices(['ADBE'], { apiKey: 'bad', fetchImpl })).rejects.toThrow(
      /rejected the API key \(401\).*Unknown API Key.*POLYGON_API_KEY/s,
    )
  })

  it('surfaces any other refusal with Polygon’s own words', async () => {
    const { fetchImpl } = fakePolygon(
      () => new Response('<h1>upstream exploded</h1>', { status: 502, statusText: 'Bad Gateway' }),
    )
    await expect(fetchPolygonPrices(['ADBE'], { apiKey: 'k', fetchImpl })).rejects.toThrow(
      /502 Bad Gateway — upstream exploded/,
    )
  })

  it('sends the key as a query parameter on the grouped endpoint', async () => {
    let asked = ''
    const fetchImpl = (async (url: string) => {
      asked = url
      return new Response(JSON.stringify(grouped({ ADBE: 1 })))
    }) as typeof fetch
    await fetchPolygonPrices(['ADBE'], { apiKey: 'secret-key', fetchImpl })
    const url = new URL(asked)
    expect(url.pathname).toMatch(/^\/v2\/aggs\/grouped\/locale\/us\/market\/stocks\/\d{4}-\d{2}-\d{2}$/)
    expect(url.searchParams.get('apiKey')).toBe('secret-key')
    expect(url.searchParams.get('adjusted')).toBe('true')
  })
})

describe('fetchYearEndCloses', () => {
  it('takes the final December session of the requested year', async () => {
    const { fetchImpl, dates } = fakePolygon((date) =>
      date === '2025-12-31' ? grouped({ ADBE: 349.99, CRM: 40 }) : empty,
    )
    const closes = await fetchYearEndCloses(['ADBE', 'CRM', 'SPCX'], 2025, {
      apiKey: 'k',
      fetchImpl,
    })
    expect(closes).toEqual({ ADBE: 349.99, CRM: 40 })
    expect(dates).toEqual(['2025-12-31'])
  })

  it('walks back within December when the 31st has no session', async () => {
    const { fetchImpl, dates } = fakePolygon((date) =>
      date === '2027-12-30' ? grouped({ ADBE: 500 }) : empty,
    )
    // Dec 31 2027 is a Friday with no file in this fixture; Dec 30 answers.
    const closes = await fetchYearEndCloses(['ADBE'], 2027, { apiKey: 'k', fetchImpl })
    expect(closes).toEqual({ ADBE: 500 })
    for (const d of dates) expect(d.startsWith('2027-12')).toBe(true)
  })

  it('returns nothing rather than crossing into the prior year', async () => {
    const { fetchImpl, dates } = fakePolygon(() => empty)
    const closes = await fetchYearEndCloses(['ADBE'], 2025, { apiKey: 'k', fetchImpl })
    expect(closes).toEqual({})
    for (const d of dates) expect(d.startsWith('2025-12')).toBe(true)
  })
})

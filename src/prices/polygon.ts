/**
 * Free end-of-day prices from Polygon.io.
 *
 * The grouped-daily endpoint returns closes for the whole US market in one
 * request, so a full universe refresh costs a single API call — well inside
 * the free tier's 5-calls-per-minute budget. Free-tier data is end of day:
 * "Update prices" lands the most recent completed session's closes.
 *
 * Needs an API key (free signup at polygon.io), read from POLYGON_API_KEY.
 *
 * This is the price fallback, not the data source of record: a successful
 * FactSet refresh supersedes it, and estimates never come from here —
 * Polygon carries no consensus estimates.
 */

const DEFAULT_BASE_URL = 'https://api.polygon.io/'
/** How many calendar days to walk back looking for the last completed session. */
const MAX_LOOKBACK_DAYS = 7
const RETRIES = 2

/**
 * Plain-US listings only: Polygon's US market covers exactly those, and the
 * dashboard works in USD. Anything else — foreign listings (they carry a
 * venue suffix like -HK) and private names — lands on the unmapped report
 * and keeps its FactSet or hand-entered price.
 */
const PLAIN_US = /^[A-Z]+$/
const PRIVATE = new Set(['SPCX']) // no public listing; there is no price

export function polygonSymbol(ticker: string): string | null {
  if (PRIVATE.has(ticker)) return null
  return PLAIN_US.test(ticker) ? ticker : null
}

export function polygonApiKeyFromEnv(): string | null {
  const key = process.env.POLYGON_API_KEY?.trim()
  return key ? key : null
}

export interface PriceUpdate {
  /** Ticker -> latest close, for everything the session file covered. */
  prices: Record<string, number>
  /** The trading session the closes belong to, YYYY-MM-DD. */
  sessionDate: string
  /** Tickers with no mapped symbol (non-US listings, private companies). */
  unmapped: string[]
  /** Mapped tickers absent from the session — delistings and renames land here. */
  unpriced: string[]
}

interface GroupedDaily {
  status?: string
  resultsCount?: number
  results?: { T?: string; c?: number }[]
  error?: string
  message?: string
}

export interface PolygonOptions {
  apiKey: string
  baseUrl?: string
  fetchImpl?: typeof fetch
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A readable slice of an error response's body, for diagnosable failures. */
async function bodySnippet(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
}

/**
 * One grouped-daily request: every US stock's close for `date`, as a map.
 * Returns null for a day with no session (weekend, holiday, not yet
 * published); throws with Polygon's own words for anything else.
 */
async function fetchGroupedDaily(
  date: string,
  options: PolygonOptions,
): Promise<Map<string, number> | null> {
  const doFetch = options.fetchImpl ?? fetch
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
  const url =
    `${baseUrl}v2/aggs/grouped/locale/us/market/stocks/${date}` +
    `?adjusted=true&apiKey=${encodeURIComponent(options.apiKey)}`

  for (let attempt = 0; ; attempt += 1) {
    const res = await doFetch(url)
    if (res.status === 429 && attempt < RETRIES) {
      // The free tier allows 5 calls a minute; wait out the window.
      await sleep(15000 * (attempt + 1))
      continue
    }
    if (res.status === 401 || res.status === 403) {
      const body = await bodySnippet(res)
      throw new Error(
        `Polygon rejected the API key (${res.status})${body ? ` — ${body}` : ''}. ` +
          'Check the POLYGON_API_KEY secret.',
      )
    }
    if (!res.ok) {
      const body = await bodySnippet(res)
      throw new Error(
        `Polygon request failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`,
      )
    }
    const payload = (await res.json().catch(() => ({}))) as GroupedDaily
    if (!payload.results?.length) return null // no session that day
    const closes = new Map<string, number>()
    for (const row of payload.results) {
      if (typeof row.T === 'string' && typeof row.c === 'number' && row.c > 0) {
        closes.set(row.T.toUpperCase(), row.c)
      }
    }
    return closes
  }
}

const dayKey = (d: Date): string => d.toISOString().slice(0, 10)

/** Calendar days to try, newest first, weekends skipped to save API calls. */
function candidateDays(from: Date, lookback: number): string[] {
  const days: string[] = []
  const cursor = new Date(from)
  for (let i = 0; i < lookback; i += 1) {
    const weekday = cursor.getUTCDay()
    if (weekday !== 0 && weekday !== 6) days.push(dayKey(cursor))
    cursor.setUTCDate(cursor.getUTCDate() - 1)
  }
  return days
}

/**
 * Latest closes for the universe: the most recent completed session's
 * grouped-daily file, walked back from yesterday until one exists.
 */
export async function fetchPolygonPrices(
  tickers: string[],
  options: PolygonOptions,
): Promise<PriceUpdate> {
  const mapped: string[] = []
  const unmapped: string[] = []
  for (const ticker of tickers) {
    if (polygonSymbol(ticker)) mapped.push(ticker)
    else unmapped.push(ticker)
  }

  // Yesterday, not today: the free tier publishes end-of-day files.
  const start = new Date(Date.now() - 24 * 60 * 60 * 1000)
  let session: Map<string, number> | null = null
  let sessionDate = ''
  for (const day of candidateDays(start, MAX_LOOKBACK_DAYS)) {
    session = await fetchGroupedDaily(day, options)
    if (session) {
      sessionDate = day
      break
    }
  }
  if (!session) {
    throw new Error(
      `Polygon returned no trading session in the last ${MAX_LOOKBACK_DAYS} days — ` +
        'is the market data entitlement active on this key?',
    )
  }

  const prices: Record<string, number> = {}
  const unpriced: string[] = []
  for (const ticker of mapped) {
    const close = session.get(ticker)
    if (close === undefined) unpriced.push(ticker)
    else prices[ticker] = close
  }
  return { prices, sessionDate, unmapped, unpriced }
}

/**
 * Closing price on the last trading day of `year`, per ticker — the
 * denominator of a year-to-date return. One grouped-daily call for the final
 * December session; fetched once per calendar year and cached upstream. The
 * analyst's bundled year-end file is the primary source; this fills gaps.
 */
export async function fetchYearEndCloses(
  tickers: string[],
  year: number,
  options: PolygonOptions,
): Promise<Record<string, number>> {
  let session: Map<string, number> | null = null
  for (const day of candidateDays(new Date(Date.UTC(year, 11, 31)), MAX_LOOKBACK_DAYS)) {
    if (!day.startsWith(`${year}-12`)) break // never cross into another year
    session = await fetchGroupedDaily(day, options)
    if (session) break
  }
  if (!session) return {}

  const closes: Record<string, number> = {}
  for (const ticker of tickers) {
    if (!polygonSymbol(ticker)) continue
    const close = session.get(ticker)
    if (close !== undefined) closes[ticker] = close
  }
  return closes
}

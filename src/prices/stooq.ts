/**
 * Free end-of-day prices from Stooq.
 *
 * Stooq serves quote CSVs with no API key: one line per symbol of
 * `Symbol,Date,Time,Open,High,Low,Close,Volume`, with `N/D` standing in for
 * anything it does not know. Coverage is strong for US listings and patchy
 * elsewhere, so the updater reports what it could not price rather than
 * leaving stale numbers standing silently.
 *
 * This is the price fallback, not the data source of record: a successful
 * FactSet refresh supersedes it, and estimates never come from here.
 */

const DEFAULT_BASE_URL = 'https://stooq.com/q/l/'
/** Daily history lives on a different path and takes one symbol per request. */
const DEFAULT_HISTORY_URL = 'https://stooq.com/q/d/l/'
const BATCH_SIZE = 40
/** Politeness cap on the one-symbol-at-a-time history endpoint. */
const HISTORY_CONCURRENCY = 6

/**
 * Node's fetch sends no User-Agent at all, and Stooq answers header-less
 * bot-looking requests with a 404 for URLs that load fine in a browser.
 * Present ordinary browser headers; the endpoint needs no more than that.
 */
const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  Accept: 'text/csv,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
} as const

/**
 * Non-US listings need explicit symbols; a wrong guess would risk pricing the
 * wrong instrument, so anything unlisted here that is not a plain US ticker
 * goes unmapped and lands on the report instead.
 */
const EXPLICIT_SYMBOLS: Record<string, string | null> = {
  '763-HK': '0763.hk',     // ZTE, Hong Kong
  'CSU-CA': 'csu.ca',      // Constellation Software, Toronto
  '005930-KR': null,       // Samsung — Stooq has no Korea coverage
  '066570-KR': null,       // LG Electronics
  '532540-IN': null,       // TCS — no India coverage
  'VSURE-OME': null,       // unlisted venue code
  SPCX: null,              // SpaceX is private; there is no price
}

const PLAIN_US = /^[A-Z]+$/

/** Stooq symbol for a universe ticker, or null when there is no safe mapping. */
export function stooqSymbol(ticker: string): string | null {
  if (ticker in EXPLICIT_SYMBOLS) return EXPLICIT_SYMBOLS[ticker] ?? null
  if (PLAIN_US.test(ticker)) return `${ticker.toLowerCase()}.us`
  return null
}

export interface Quote {
  close: number
  date: string
}

/** Parse Stooq's quote CSV into symbol -> close. Unknown symbols are absent. */
export function parseStooqCsv(csv: string): Map<string, Quote> {
  const quotes = new Map<string, Quote>()
  for (const line of csv.split('\n')) {
    const cells = line.trim().split(',')
    if (cells.length < 7) continue
    const [symbol, date, , , , , close] = cells
    if (!symbol || symbol.toLowerCase() === 'symbol') continue // header row
    const value = Number(close)
    if (!Number.isFinite(value) || value <= 0) continue // N/D or junk
    quotes.set(symbol.toLowerCase(), { close: value, date: date ?? '' })
  }
  return quotes
}

export interface PriceUpdate {
  /** Ticker -> latest close, for everything Stooq could price. */
  prices: Record<string, number>
  /** Tickers with no mapped symbol (non-US listings, private companies). */
  unmapped: string[]
  /** Mapped tickers Stooq returned nothing for — delistings and renames land here. */
  unpriced: string[]
}

export async function fetchStooqPrices(
  tickers: string[],
  options: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<PriceUpdate> {
  const doFetch = options.fetchImpl ?? fetch
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL

  const mapping = new Map<string, string>() // stooq symbol -> our ticker
  const unmapped: string[] = []
  for (const ticker of tickers) {
    const symbol = stooqSymbol(ticker)
    if (symbol) mapping.set(symbol, ticker)
    else unmapped.push(ticker)
  }

  const symbols = [...mapping.keys()]
  const prices: Record<string, number> = {}

  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE)
    const url = `${baseUrl}?s=${batch.join('+')}&f=sd2t2ohlcv&h&e=csv`
    const res = await doFetch(url, { headers: REQUEST_HEADERS })
    if (!res.ok) {
      // Surface what Stooq actually said — a bare status is undiagnosable.
      const body = (await res.text().catch(() => '')).replace(/<[^>]*>/g, ' ').trim().slice(0, 160)
      throw new Error(
        `Stooq request failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`,
      )
    }
    const quotes = parseStooqCsv(await res.text())
    for (const [symbol, quote] of quotes) {
      const ticker = mapping.get(symbol)
      if (ticker) prices[ticker] = quote.close
    }
  }

  const unpriced = [...mapping.entries()]
    .filter(([symbol]) => !(mapping.get(symbol)! in prices))
    .map(([, ticker]) => ticker)

  return { prices, unmapped, unpriced }
}

/**
 * Parse Stooq's daily history CSV (`Date,Open,High,Low,Close,Volume`) and
 * return the last close in the file.
 */
export function lastCloseFromHistory(csv: string): number | null {
  let last: number | null = null
  for (const line of csv.split('\n')) {
    const cells = line.trim().split(',')
    if (cells.length < 5) continue
    if (cells[0]?.toLowerCase() === 'date') continue
    const close = Number(cells[4])
    if (Number.isFinite(close) && close > 0) last = close
  }
  return last
}

/**
 * Closing price on the last trading day of `year`, per ticker.
 *
 * This is the denominator of a year-to-date return, so it is fetched once per
 * calendar year and cached — the December window is asked for rather than a
 * single date because the last session of the year moves with the holidays.
 *
 * The history endpoint serves one symbol per request, so this is deliberately
 * throttled; it runs only for tickers whose close for the year is not already
 * stored.
 */
export async function fetchYearEndCloses(
  tickers: string[],
  year: number,
  options: { historyUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<Record<string, number>> {
  const doFetch = options.fetchImpl ?? fetch
  const historyUrl = options.historyUrl ?? DEFAULT_HISTORY_URL
  const closes: Record<string, number> = {}

  const targets = tickers
    .map((ticker) => ({ ticker, symbol: stooqSymbol(ticker) }))
    .filter((t): t is { ticker: string; symbol: string } => t.symbol !== null)

  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < targets.length) {
      const target = targets[cursor++]
      if (!target) return
      const url = `${historyUrl}?s=${target.symbol}&d1=${year}1215&d2=${year}1231&i=d`
      try {
        const res = await doFetch(url, { headers: REQUEST_HEADERS })
        if (!res.ok) continue
        const close = lastCloseFromHistory(await res.text())
        if (close !== null) closes[target.ticker] = close
      } catch {
        // One unreachable symbol must not sink the whole year-end pass.
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(HISTORY_CONCURRENCY, targets.length) }, worker),
  )
  return closes
}

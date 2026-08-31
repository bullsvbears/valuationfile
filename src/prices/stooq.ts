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
const BATCH_SIZE = 40

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
    const res = await doFetch(url)
    if (!res.ok) {
      throw new Error(`Stooq request failed: ${res.status} ${res.statusText}`)
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

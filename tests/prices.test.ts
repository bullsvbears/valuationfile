import { describe, expect, it } from 'vitest'
import { fetchStooqPrices, parseStooqCsv, stooqSymbol } from '../src/prices/stooq.js'

describe('symbol mapping', () => {
  it('maps plain US tickers to .us symbols', () => {
    expect(stooqSymbol('ADBE')).toBe('adbe.us')
    expect(stooqSymbol('U')).toBe('u.us')
  })

  it('maps known internationals explicitly', () => {
    expect(stooqSymbol('763-HK')).toBe('0763.hk')
    expect(stooqSymbol('CSU-CA')).toBe('csu.ca')
  })

  it('refuses to guess: no-coverage listings and private names map to null', () => {
    // A wrong guess would price the wrong instrument; null lands the ticker
    // on the report instead.
    for (const t of ['005930-KR', '532540-IN', 'VSURE-OME', 'SPCX', 'WEIRD-XX']) {
      expect(stooqSymbol(t)).toBeNull()
    }
  })
})

describe('CSV parsing', () => {
  const csv = [
    'Symbol,Date,Time,Open,High,Low,Close,Volume',
    'ADBE.US,2026-08-29,22:00:04,290.1,295.2,289.4,293.55,2412345',
    'CRM.US,2026-08-29,22:00:04,255.0,260.1,254.2,259.39,5012345',
    'GONE.US,N/D,N/D,N/D,N/D,N/D,N/D,N/D',
    '',
  ].join('\n')

  it('reads closes and skips the header', () => {
    const quotes = parseStooqCsv(csv)
    expect(quotes.get('adbe.us')?.close).toBe(293.55)
    expect(quotes.get('crm.us')?.close).toBe(259.39)
  })

  it('drops N/D rows instead of producing zeros', () => {
    expect(parseStooqCsv(csv).has('gone.us')).toBe(false)
  })
})

describe('fetching', () => {
  it('prices what it can and reports the rest', async () => {
    const served = new Map([
      ['adbe.us', 293.55],
      ['crm.us', 259.39],
    ])
    const fetchImpl = (async (url: string) => {
      const symbols = new URL(url).searchParams.get('s')!.split(' ')
      const lines = ['Symbol,Date,Time,Open,High,Low,Close,Volume']
      for (const s of symbols) {
        const close = served.get(s)
        lines.push(
          close !== undefined
            ? `${s.toUpperCase()},2026-08-29,22:00:00,1,1,1,${close},100`
            : `${s.toUpperCase()},N/D,N/D,N/D,N/D,N/D,N/D,N/D`,
        )
      }
      return new Response(lines.join('\n'))
    }) as typeof fetch

    const result = await fetchStooqPrices(['ADBE', 'CRM', 'DELISTED', 'SPCX'], { fetchImpl })
    expect(result.prices).toEqual({ ADBE: 293.55, CRM: 259.39 })
    expect(result.unpriced).toEqual(['DELISTED'])
    expect(result.unmapped).toEqual(['SPCX'])
  })

  it('surfaces an HTTP failure rather than reporting everything unpriced', async () => {
    const fetchImpl = (async () => new Response('', { status: 503, statusText: 'down' })) as typeof fetch
    await expect(fetchStooqPrices(['ADBE'], { fetchImpl })).rejects.toThrow('503')
  })
})

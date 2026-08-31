import ExcelJS from 'exceljs'

import { median, summariseGroup } from '../src/lib/aggregate.js'
import type { CompanyView, Dashboard } from '../src/lib/dashboard.js'
import { isMeaningful, type CompanyMetrics, type YearMetrics } from '../src/lib/metrics.js'
import { computeMovers, type MoverSnapshot } from '../src/lib/movers.js'
import type { MetricKey } from '../src/lib/types.js'

/**
 * The dashboard as an Excel workbook: one sheet per tab, laid out the way
 * the tab shows its data — Summary movers, the Master Input grids (with the
 * source tier as font colour), the Screen table, both peers tabs with their
 * constituents, and the Changes comparison. Every cell is a real number with
 * an Excel number format, not text, so the sheets pivot and chart cleanly.
 */

// Number formats matching the app's display conventions.
const FMT = {
  money: '"$"#,##0;[Red]-"$"#,##0',
  price: '"$"#,##0.00;[Red]-"$"#,##0.00',
  multiple: '0.0"x"',
  percent: '0.0%;[Red]-0.0%',
  return: '+0.0%;[Red]-0.0%;0.0%',
} as const

const TIER_COLOR: Record<string, string> = {
  model: 'FF7C3AED', // purple, as in the UI legend
  override: 'FFB45309', // amber
}

const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFF1F3F5' },
}

function addHeader(sheet: ExcelJS.Worksheet, labels: string[]): void {
  const row = sheet.addRow(labels)
  row.font = { bold: true, size: 10 }
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL
    cell.border = { bottom: { style: 'thin' } }
  })
  sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: sheet.rowCount }]
}

/** A numeric cell value: meaningful numbers stay, nm and null become blank. */
function num(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function meaningful(value: number | null | undefined): number | null {
  return isMeaningful(value ?? null) ? (value as number) : null
}

interface SummarySheetInputs {
  snapshot: MoverSnapshot
  date: string
}

function addSummarySheet(
  workbook: ExcelJS.Workbook,
  dashboard: Dashboard,
  compare: SummarySheetInputs | null,
): void {
  const sheet = workbook.addWorksheet('Summary')
  sheet.getColumn(1).width = 34
  sheet.getColumn(2).width = 26
  for (const c of [3, 4, 5]) sheet.getColumn(c).width = 13

  if (!compare) {
    sheet.addRow(['No earlier snapshot to compare against yet.'])
    return
  }
  const movers = computeMovers(dashboard, compare.snapshot, dashboard.summaryYear)

  const section = (
    title: string,
    header: string[],
    rows: (string | number | null)[][],
    pctCol: number,
  ) => {
    const titleRow = sheet.addRow([`${title} — since ${compare.date}`])
    titleRow.font = { bold: true, size: 11 }
    addHeader(sheet, header)
    for (const row of rows) {
      const added = sheet.addRow(row)
      added.getCell(pctCol).numFmt = FMT.return
    }
    if (!rows.length) sheet.addRow(['none'])
    sheet.addRow([])
  }

  section(
    'Master input changes',
    ['Company', 'What moved', 'Then', 'Now', '%Δ', 'Source'],
    movers.estimates.map((m) => [m.ticker, m.detail, m.then, m.now, m.percent, m.tier ?? '']),
    5,
  )
  section(
    'Price moves',
    ['Company', 'Name', 'Then', 'Now', '%Δ'],
    movers.prices.map((m) => [m.ticker, m.detail, m.then, m.now, m.percent]),
    5,
  )
  section(
    'Multiple re-ratings',
    ['Company', 'What moved', 'Then', 'Now', '%Δ'],
    movers.multiples.map((m) => [m.ticker, m.detail, m.then, m.now, m.percent]),
    5,
  )
  section(
    'Comp groups seeing input changes',
    ['Group', 'Kind', 'Changed', 'Of', 'Median move'],
    movers.groups.map((g) => [g.group, g.kind, g.changed, g.total, g.medianMove]),
    5,
  )
  // The frozen pane from the last header is wrong for a sectioned sheet.
  sheet.views = [{ state: 'frozen', ySplit: 0 }]
}

const INPUT_METRICS: { key: MetricKey; label: string }[] = [
  { key: 'revenue', label: 'Revenue' },
  { key: 'grossProfit', label: 'Gross Profit' },
  { key: 'ebitda', label: 'EBITDA' },
  { key: 'eps', label: 'EPS' },
  { key: 'fcf', label: 'FCF' },
]

function addInputSheets(workbook: ExcelJS.Workbook, dashboard: Dashboard): void {
  for (const { key, label } of INPUT_METRICS) {
    const sheet = workbook.addWorksheet(`Input ${label}`)
    sheet.getColumn(1).width = 10
    sheet.getColumn(2).width = 30
    addHeader(sheet, ['Ticker', 'Company', ...dashboard.years])
    for (const company of dashboard.companies) {
      const cells = dashboard.years.map((year) => {
        const resolved = company.resolved.series[key][year]
        return num(resolved?.value)
      })
      const row = sheet.addRow([company.meta.ticker, company.meta.name, ...cells])
      dashboard.years.forEach((year, index) => {
        const cell = row.getCell(3 + index)
        cell.numFmt = key === 'eps' ? FMT.price : FMT.money
        const tier = company.resolved.series[key][year]?.tier
        const color = tier ? TIER_COLOR[tier] : undefined
        if (color) cell.font = { color: { argb: color } }
      })
    }
  }

  const sheet = workbook.addWorksheet('Input Balance')
  sheet.getColumn(1).width = 10
  sheet.getColumn(2).width = 30
  addHeader(sheet, ['Ticker', 'Company', 'Price', 'Prior YE close', 'Shares', 'Cash', 'Debt'])
  for (const company of dashboard.companies) {
    const row = sheet.addRow([
      company.meta.ticker,
      company.meta.name,
      num(company.metrics.price),
      num(company.priorYearClose.value),
      num(company.resolved.balance.shares?.value),
      num(company.resolved.balance.cash?.value),
      num(company.resolved.balance.debt?.value),
    ])
    row.getCell(3).numFmt = FMT.price
    row.getCell(4).numFmt = FMT.price
    for (const c of [5, 6, 7]) row.getCell(c).numFmt = FMT.money
  }
}

const SCREEN_VALUATION: { key: keyof YearMetrics; label: string; fmt: string }[] = [
  { key: 'evRevenue', label: 'EV/Rev', fmt: FMT.multiple },
  { key: 'evRevenueGrowth', label: 'EV/Rev/G', fmt: FMT.multiple },
  { key: 'evRevenueR40', label: 'EV/Rev/R40', fmt: FMT.multiple },
  { key: 'evGrossProfit', label: 'EV/GP', fmt: FMT.multiple },
  { key: 'evEbitda', label: 'EV/EBITDA', fmt: FMT.multiple },
  { key: 'evFcf', label: 'EV/FCF', fmt: FMT.multiple },
  { key: 'pe', label: 'P/E', fmt: FMT.multiple },
  { key: 'fcfYield', label: 'FCF Yld', fmt: FMT.percent },
]

const FUNDAMENTALS: { key: keyof YearMetrics; label: string; fmt: string }[] = [
  { key: 'revenue', label: 'Revenue', fmt: FMT.money },
  { key: 'revenueGrowth', label: 'Rev Growth', fmt: FMT.percent },
  { key: 'grossMargin', label: 'Gross Margin', fmt: FMT.percent },
  { key: 'ebitdaMargin', label: 'EBITDA Margin', fmt: FMT.percent },
  { key: 'fcfMargin', label: 'FCF Margin', fmt: FMT.percent },
  { key: 'ruleOf40', label: 'Rule of 40', fmt: FMT.percent },
]

function addScreenSheet(workbook: ExcelJS.Workbook, dashboard: Dashboard): void {
  const sheet = workbook.addWorksheet('Screen')
  const year = dashboard.years[dashboard.years.length - 1] ?? ''
  const fundamentalYears = dashboard.years.slice(-3)

  sheet.getColumn(1).width = 10
  sheet.getColumn(2).width = 30
  addHeader(sheet, [
    'Ticker',
    'Company',
    'Price',
    'YTD',
    'Mkt Cap',
    'EV',
    ...SCREEN_VALUATION.map((v) => `${v.label} ${year}`),
    ...FUNDAMENTALS.flatMap((f) => fundamentalYears.map((fy) => `${f.label} ${fy}`)),
  ])

  const live = dashboard.companies
    .filter((c) => c.meta.coverage !== 'Acquired Companies')
    .sort((a, b) => a.meta.ticker.localeCompare(b.meta.ticker))
  for (const company of live) {
    const byYear = company.metrics.byYear
    const row = sheet.addRow([
      company.meta.ticker,
      company.meta.name,
      num(company.metrics.price),
      num(company.ytdReturn),
      meaningful(company.metrics.marketCap),
      meaningful(company.metrics.enterpriseValue),
      ...SCREEN_VALUATION.map((v) => meaningful(byYear[year]?.[v.key] as number | null)),
      ...FUNDAMENTALS.flatMap((f) =>
        fundamentalYears.map((fy) => meaningful(byYear[fy]?.[f.key] as number | null)),
      ),
    ])
    const fmts = [
      FMT.price,
      FMT.return,
      FMT.money,
      FMT.money,
      ...SCREEN_VALUATION.map((v) => v.fmt),
      ...FUNDAMENTALS.flatMap((f) => fundamentalYears.map(() => f.fmt)),
    ]
    fmts.forEach((fmt, index) => {
      row.getCell(3 + index).numFmt = fmt
    })
  }
}

const PEER_VALUATION: { key: keyof YearMetrics; label: string; fmt: string }[] = [
  { key: 'evRevenue', label: 'EV/Rev', fmt: FMT.multiple },
  { key: 'evGrossProfit', label: 'EV/GP', fmt: FMT.multiple },
  { key: 'evEbitda', label: 'EV/EBITDA', fmt: FMT.multiple },
  { key: 'evFcf', label: 'EV/FCF', fmt: FMT.multiple },
  { key: 'pe', label: 'P/E', fmt: FMT.multiple },
]

const PEER_FUNDAMENTALS: { key: keyof YearMetrics; label: string; fmt: string }[] = [
  { key: 'revenue', label: 'Revenue', fmt: FMT.money },
  { key: 'revenueGrowth', label: 'Rev Growth', fmt: FMT.percent },
  { key: 'grossMargin', label: 'Gross Margin', fmt: FMT.percent },
  { key: 'fcfMargin', label: 'FCF Margin', fmt: FMT.percent },
  { key: 'ruleOf40', label: 'Rule of 40', fmt: FMT.percent },
]

function addPeerSheet(
  workbook: ExcelJS.Workbook,
  dashboard: Dashboard,
  name: 'Sector Peers' | 'Financial Peers',
): void {
  const sheet = workbook.addWorksheet(name)
  const rosters = (
    name === 'Sector Peers' ? dashboard.sectorSummaries : dashboard.peerSummaries
  ).filter((g) => g.members.length > 0)

  const valuationYears = dashboard.years.slice(-2)
  const fundamentalYears = dashboard.years.slice(-3)
  const companyByTicker = new Map<string, CompanyView>(
    dashboard.companies.map((c) => [c.meta.ticker, c]),
  )

  sheet.getColumn(1).width = 34
  addHeader(sheet, [
    'Group / constituent',
    'N',
    'YTD',
    ...PEER_VALUATION.flatMap((v) => valuationYears.map((y) => `${v.label} ${y}`)),
    ...PEER_FUNDAMENTALS.flatMap((f) => fundamentalYears.map((y) => `${f.label} ${y}`)),
  ])
  const fmts = [
    FMT.return,
    ...PEER_VALUATION.flatMap((v) => valuationYears.map(() => v.fmt)),
    ...PEER_FUNDAMENTALS.flatMap((f) => fundamentalYears.map(() => f.fmt)),
  ]
  const applyFmts = (row: ExcelJS.Row) =>
    fmts.forEach((fmt, index) => {
      row.getCell(3 + index).numFmt = fmt
    })

  for (const roster of rosters) {
    const memberViews = roster.members
      .map((t) => companyByTicker.get(t))
      .filter((c): c is CompanyView => Boolean(c))
    const memberMetrics: CompanyMetrics[] = memberViews.map((c) => c.metrics)
    const statsFor = new Map(
      [...new Set([...valuationYears, ...fundamentalYears])].map((year) => [
        year,
        summariseGroup(roster.group, memberMetrics, year).stats,
      ]),
    )
    const stat = (year: string, key: keyof YearMetrics): number | null =>
      (statsFor.get(year)?.[key as 'evRevenue'] ?? undefined)?.median ?? null

    // Group medians, then each constituent with its own numbers.
    const groupRow = sheet.addRow([
      roster.group,
      roster.members.length,
      median(
        memberViews.map((c) => c.ytdReturn).filter((v): v is number => typeof v === 'number'),
      ),
      ...PEER_VALUATION.flatMap((v) => valuationYears.map((y) => stat(y, v.key))),
      ...PEER_FUNDAMENTALS.flatMap((f) => fundamentalYears.map((y) => stat(y, f.key))),
    ])
    groupRow.font = { bold: true }
    applyFmts(groupRow)

    for (const company of memberViews) {
      const row = sheet.addRow([
        `    ${company.meta.ticker} — ${company.meta.name}`,
        null,
        num(company.ytdReturn),
        ...PEER_VALUATION.flatMap((v) =>
          valuationYears.map((y) => meaningful(company.metrics.byYear[y]?.[v.key] as number | null)),
        ),
        ...PEER_FUNDAMENTALS.flatMap((f) =>
          fundamentalYears.map((y) => meaningful(company.metrics.byYear[y]?.[f.key] as number | null)),
        ),
      ])
      applyFmts(row)
    }
  }
}

/** The Changes tab's Today/Then/Δ blocks, per comp group. */
const CHANGE_BLOCKS = [
  { key: 'evRevenue', label: 'EV/Rev', fmt: FMT.multiple, delta: 'pct' as const },
  { key: 'revenue', label: 'Rev', fmt: FMT.money, delta: 'pct' as const },
  { key: 'revenueGrowth', label: 'Rev Growth', fmt: FMT.percent, delta: 'pts' as const },
  { key: 'evFcf', label: 'EV/FCF', fmt: FMT.multiple, delta: 'pct' as const },
  { key: 'fcfMargin', label: 'FCF Margin', fmt: FMT.percent, delta: 'pts' as const },
  { key: 'ruleOf40', label: 'Rule of 40', fmt: FMT.percent, delta: 'pts' as const },
]

function addChangesSheet(
  workbook: ExcelJS.Workbook,
  dashboard: Dashboard,
  compare: SummarySheetInputs | null,
): void {
  const sheet = workbook.addWorksheet('Changes')
  sheet.getColumn(1).width = 34
  if (!compare) {
    sheet.addRow(['No earlier snapshot to compare against yet.'])
    return
  }

  const year = dashboard.years[dashboard.years.length - 1] ?? ''
  const priorYear = String(Number(year) - 1)
  const companyByTicker = new Map<string, CompanyView>(
    dashboard.companies.map((c) => [c.meta.ticker, c]),
  )

  /** Per-company then-values reconstructed from the snapshot, as on the tab. */
  const thenByTicker = new Map<string, Record<string, number | null>>()
  for (const [ticker, past] of Object.entries(compare.snapshot.companies)) {
    const rev = past.series?.revenue?.[year] ?? null
    const revPrior = past.series?.revenue?.[priorYear] ?? null
    const fcf = past.series?.fcf?.[year] ?? null
    const growth =
      rev !== null && revPrior !== null && revPrior !== 0 ? rev / Math.abs(revPrior) - 1 : null
    const margin = rev !== null && rev !== 0 && fcf !== null ? fcf / rev : null
    thenByTicker.set(ticker, {
      price: past.price ?? null,
      evRevenue: past.multiples?.[year]?.evRevenue ?? null,
      evFcf: past.multiples?.[year]?.evFcf ?? null,
      revenue: rev,
      revenueGrowth: growth,
      fcfMargin: margin,
      ruleOf40: growth !== null && margin !== null ? growth + margin : null,
    })
  }

  const writeSection = (
    title: string,
    rosters: { group: string; members: string[] }[],
  ) => {
    const titleRow = sheet.addRow([title])
    titleRow.font = { bold: true, size: 11 }
    addHeader(sheet, [
      'Group',
      'N',
      'YTD',
      `Since ${compare.date}`,
      ...CHANGE_BLOCKS.flatMap((b) => [
        `${year} ${b.label} today`,
        `${compare.date}`,
        b.delta === 'pts' ? 'Δ pts' : '%Δ',
      ]),
    ])

    for (const roster of rosters.filter((r) => r.members.length > 0)) {
      const members = roster.members
        .map((t) => companyByTicker.get(t))
        .filter((c): c is CompanyView => Boolean(c))

      const sinceMoves = members
        .map((c) => {
          const priceThen = thenByTicker.get(c.meta.ticker)?.price
          return typeof priceThen === 'number' && priceThen !== 0 && c.metrics.price !== null
            ? c.metrics.price / priceThen - 1
            : null
        })
        .filter((v): v is number => v !== null)

      const cells: (number | null)[] = []
      const cellFmts: string[] = [FMT.return, FMT.return]
      for (const block of CHANGE_BLOCKS) {
        const today = median(
          members
            .map((c) => {
              const v = c.metrics.byYear[year]?.[block.key as 'evRevenue'] ?? null
              return isMeaningful(v) ? v : null
            })
            .filter((v): v is number => v !== null),
        )
        const then = median(
          members
            .map((c) => thenByTicker.get(c.meta.ticker)?.[block.key] ?? null)
            .filter((v): v is number => typeof v === 'number'),
        )
        const delta =
          today === null || then === null
            ? null
            : block.delta === 'pct'
              ? then === 0
                ? null
                : today / then - 1
              : today - then
        cells.push(today, then, delta)
        cellFmts.push(block.fmt, block.fmt, FMT.return)
      }

      const row = sheet.addRow([
        roster.group,
        roster.members.length,
        median(members.map((c) => c.ytdReturn).filter((v): v is number => v !== null)),
        median(sinceMoves),
        ...cells,
      ])
      cellFmts.forEach((fmt, index) => {
        row.getCell(3 + index).numFmt = fmt
      })
    }
    sheet.addRow([])
  }

  writeSection('Sector groups', dashboard.sectorSummaries)
  writeSection('Financial groups', dashboard.peerSummaries)
  sheet.views = [{ state: 'frozen', ySplit: 0 }]
}

/**
 * Build the whole workbook. `compare` carries the latest prior snapshot for
 * the Summary and Changes sheets; null when history is still empty.
 */
export function buildExportWorkbook(
  dashboard: Dashboard,
  compare: SummarySheetInputs | null,
): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook()
  workbook.created = new Date()
  addSummarySheet(workbook, dashboard, compare)
  addInputSheets(workbook, dashboard)
  addScreenSheet(workbook, dashboard)
  addPeerSheet(workbook, dashboard, 'Sector Peers')
  addPeerSheet(workbook, dashboard, 'Financial Peers')
  addChangesSheet(workbook, dashboard, compare)
  return workbook
}

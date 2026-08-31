import ExcelJS from 'exceljs'

/**
 * A tiny in-memory valuation workbook in the layout src/workbook/extract.ts
 * expects: the `Data` sheet with coverage headers and formula-typed cells,
 * prices on `Master Software`, and the two grouping sheets — including the
 * awkward cases the real file contains (merged group headers, a cached
 * formula result of 0, duplicate ticker rows, month helper rows).
 */
export async function buildTestWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()

  const data = wb.addWorksheet('Data')
  // Row 3 carries the calendar year over each metric column.
  data.getCell(3, 4).value = 2025 // revenue block starts at column 4
  data.getCell(3, 5).value = 2026
  data.getCell(3, 16).value = 2025 // gross profit block starts at column 16

  data.getCell(4, 1).value = 'Bhatia - Covered Companies'

  // AAAA holds one cell per tier: model link, FactSet pull, typed number.
  data.getCell(5, 1).value = 'AAAA'
  data.getCell(5, 2).value = 'Alpha Corp'
  data.getCell(5, 3).value = 12
  data.getCell(5, 4).value = { formula: '[6]IS!$AY$6', result: 100 }
  data.getCell(5, 5).value = {
    formula: 'IFERROR(_xll.FDS($A5,"FE_ESTIMATE(SALES,MEAN,ANN,+1,,,USD)")/1000,"na")',
    result: 120,
  }
  data.getCell(5, 16).value = 80
  data.getCell(5, 60).value = { formula: '_xll.FDS($A5,"FCS_SHARES_INTERIM(0,USD)")', result: 50 }
  data.getCell(5, 61).value = 10
  data.getCell(5, 62).value = { formula: '[6]BS!$B$2', result: 5 }

  data.getCell(6, 1).value = 'Non-Covered Companies'
  // BBBB's revenue caches a real result of 0, which exceljs's value getter drops.
  data.getCell(7, 1).value = 'BBBB'
  data.getCell(7, 2).value = 'Beta Inc'
  data.getCell(7, 3).value = 12
  data.getCell(7, 4).value = { formula: 'FDS($A7,"FE_ESTIMATE(SALES,MEAN,ANN,0,,,USD)")', result: 0 }

  // A repeated ticker row (never reached by the workbook's VLOOKUPs) and a
  // month helper row (numeric name cell) must both be skipped.
  data.getCell(8, 1).value = 'AAAA'
  data.getCell(8, 2).value = 'Alpha Corp, duplicated'
  data.getCell(8, 3).value = 12
  data.getCell(8, 4).value = 999
  data.getCell(9, 1).value = 'Jan'
  data.getCell(9, 2).value = 1

  const master = wb.addWorksheet('Master Software')
  master.getCell(6, 3).value = 'AAAA'
  master.getCell(6, 4).value = 55.5
  master.getCell(6, 5).value = 0.1
  master.getCell(6, 6).value = -0.2
  master.getCell(7, 3).value = 'BBBB'
  master.getCell(7, 4).value = { formula: '_xll.FDS(C7,"P_PRICE(NOW,,,USD)")', result: 20 }
  master.getCell(7, 5).value = { formula: 'IFERROR(1,2)', result: 0 } // a flat YTD, cached as 0
  master.getCell(7, 6).value = 0.05

  const sectors = wb.addWorksheet('Software Groups by Sector')
  sectors.getCell(4, 2).value = 'Infrastructure' // header: nothing in column C
  sectors.getCell(5, 2).value = 'Alpha Corp'
  sectors.getCell(5, 3).value = 'AAAA'
  sectors.getCell(6, 2).value = 'Mean' // stat row, never a member
  sectors.getCell(6, 3).value = 1.5
  // The real sheet also writes headers as B:C merges; the merged C cell must
  // still read as empty, as openpyxl reads it.
  sectors.getCell(8, 2).value = 'Merged Group'
  sectors.mergeCells(8, 2, 8, 3)
  sectors.getCell(9, 2).value = 'Beta Inc'
  sectors.getCell(9, 3).value = 'BBBB'

  const fins = wb.addWorksheet('Software Groups by Financials')
  fins.getCell(4, 2).value = 'High Growth'
  fins.getCell(5, 2).value = 'Alpha Corp'
  fins.getCell(5, 3).value = 'AAAA'

  const buffer = await wb.xlsx.writeBuffer()
  return Buffer.from(buffer as ArrayBuffer)
}

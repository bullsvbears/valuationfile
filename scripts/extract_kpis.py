#!/usr/bin/env python3
"""
Extract the operating KPI blocks from the Master Software sheet.

The sheet carried ~18 KPI blocks (NDRR, gross retention, CAC payback,
customer-count tiers, SBC %, and so on) to the right of the valuation
columns — data the first import skipped. Each block is a run of year columns
under one row-3 label. Values are read as cached results (many cells were
formulas), keyed ticker -> kpi -> year.

Usage:  python3 scripts/extract_kpis.py <workbook.xlsx> [--out data/kpis.json]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import openpyxl

# The KPI region of Master Software: columns ET through LO, rows as imported.
FIRST_COL = 150   # ET
LAST_COL = 327    # LO
FIRST_ROW = 6
LAST_ROW = 444
TICKER_COL = 3    # C

# Row-3 labels mapped to stable keys. Anything unlisted is skipped on purpose.
BLOCKS = {
    "NDRR": "ndrr",
    "Gross Retention ($)": "grossRetention",
    "Est. CAC Payback (months)": "cacPaybackMonths",
    "Est. Net Incremental ARR/CAC": "netIncrementalArrPerCac",
    "Est. LTV:CAC": "ltvToCac",
    "Subscription Rev %": "subscriptionRevenuePct",
    "Avg Revenue per Customer": "avgRevenuePerCustomer",
    "Revenue Per FTE": "revenuePerFte",
    "Paid Customers": "paidCustomers",
    "International Rev %": "internationalRevenuePct",
    "FTEs": "ftes",
    "SBC as a % of Revs": "sbcPctOfRevenue",
    "Customers >$50K ARR": "customersOver50k",
    "Customers >$100K ARR": "customersOver100k",
    "Customers >$250K ARR": "customersOver250k",
    "Customers >$500K ARR": "customersOver500k",
    "Customers >$1M ARR": "customersOver1m",
    "FCF adj for SBC Margin": "fcfAdjSbcMargin",
}


def number_or_none(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbook", type=Path)
    parser.add_argument("--out", type=Path, default=Path("data/kpis.json"))
    args = parser.parse_args()

    wb = openpyxl.load_workbook(args.workbook, data_only=True, read_only=True)
    sheet = wb["Master Software"]

    rows = list(
        sheet.iter_rows(min_row=3, max_row=LAST_ROW, max_col=LAST_COL, values_only=True)
    )
    labels, years = rows[0], rows[1]  # sheet rows 3 and 4

    # Map each column in the KPI region to (kpi key, year).
    columns: dict[int, tuple[str, str]] = {}
    current: str | None = None
    for col in range(FIRST_COL, LAST_COL + 1):
        label = labels[col - 1]
        if isinstance(label, str) and label.strip():
            current = BLOCKS.get(label.strip().replace("\n", " "))
        year = years[col - 1]
        if current and isinstance(year, (int, float)) and not isinstance(year, bool):
            columns[col] = (current, str(int(year)))

    kpis: dict[str, dict[str, dict[str, float]]] = {}
    for row in rows[3:]:  # sheet row 6 onward
        ticker = row[TICKER_COL - 1]
        if not isinstance(ticker, str) or not ticker.strip() or ticker.startswith("#"):
            continue
        ticker = ticker.strip()
        for col, (kpi, year) in columns.items():
            value = number_or_none(row[col - 1])
            if value is None:
                continue
            kpis.setdefault(ticker, {}).setdefault(kpi, {})[year] = value

    args.out.write_text(json.dumps(kpis, indent=1) + "\n")
    cells = sum(len(y) for c in kpis.values() for y in c.values())
    print(f"{len(kpis)} companies, {cells} KPI cells -> {args.out}")


if __name__ == "__main__":
    main()

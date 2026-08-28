#!/usr/bin/env python3
"""
Capture the workbook's own computed multiples as a regression fixture.

The Master Software sheet holds cached results for every multiple the dashboard
recomputes. Snapshotting them lets the test suite assert that the ported
metrics engine reproduces the spreadsheet the desk already reconciles against,
rather than merely being self-consistent.

Usage:  python3 scripts/build_reconciliation_fixture.py <workbook.xlsx> [--out tests/fixtures]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import openpyxl

# Master Software columns holding a computed multiple, as (column, metric, year).
# Column letters are resolved to indices below.
COLUMNS = {
    "evRevenue": {"I": 2025, "J": 2026, "K": 2027},
    "evRevenueGrowth": {"L": 2025, "M": 2026, "N": 2027},
    "evRevenueR40": {"O": 2025, "P": 2026, "Q": 2027},
    "evGrossProfit": {"R": 2025, "S": 2026, "T": 2027},
    "evEbitda": {"U": 2025, "V": 2026, "W": 2027},
    "evFcf": {"X": 2025, "Y": 2026, "Z": 2027},
    "fcfYield": {"AA": 2025, "AB": 2026, "AC": 2027},
    "pe": {"AD": 2025, "AE": 2026, "AF": 2027},
    "revenueGrowth": {"AN": 2025, "AO": 2026, "AP": 2027},
    "ruleOf40": {"AW": 2025, "AX": 2026, "AY": 2027},
}

# Master Software also caches the *inputs* each multiple was struck from, one
# contiguous block of years per metric. Capturing these lets the test tell a
# porting bug apart from a row Excel simply had not recalculated: if the cached
# inputs no longer match the Data sheet, there is no correct output to reproduce.
INPUT_BLOCKS = {
    "revenue": ("CY", 2017, 2027),
    "grossProfit": ("DJ", 2019, 2027),
    "ebitda": ("DS", 2019, 2027),
    "fcf": ("EB", 2019, 2027),
    "eps": ("EK", 2019, 2027),
}

MASTER_LAST_ROW = 444
MASTER_LAST_COL = 150


def column_index(letter: str) -> int:
    index = 0
    for char in letter:
        index = index * 26 + (ord(char) - ord("A") + 1)
    return index


def cell_value(value):
    """Normalise a cached cell into a number, the string "nm", or None."""
    if isinstance(value, str):
        return "nm" if value.strip().lower() == "nm" else None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbook", type=Path)
    parser.add_argument("--out", type=Path, default=Path("tests/fixtures"))
    args = parser.parse_args()

    workbook = openpyxl.load_workbook(args.workbook, data_only=True, read_only=True)
    sheet = workbook["Master Software"]

    expected: dict[str, dict] = {}
    for row in sheet.iter_rows(
        min_row=6, max_row=MASTER_LAST_ROW, max_col=MASTER_LAST_COL, values_only=True
    ):
        ticker = row[2]
        if not isinstance(ticker, str) or not ticker.strip():
            continue
        ticker = ticker.strip()
        if ticker.startswith("#"):  # an Excel error such as #NUM!, not a ticker
            continue

        entry = {
            "price": cell_value(row[3]),
            "marketCap": cell_value(row[6]),
            "enterpriseValue": cell_value(row[7]),
            "metrics": {},
            "inputs": {},
        }
        for metric, (first_letter, first_year, last_year) in INPUT_BLOCKS.items():
            first_col = column_index(first_letter)
            for offset, year in enumerate(range(first_year, last_year + 1)):
                value = cell_value(row[first_col - 1 + offset])
                if isinstance(value, (int, float)):
                    entry["inputs"].setdefault(metric, {})[str(year)] = value

        for metric, columns in COLUMNS.items():
            for letter, year in columns.items():
                value = cell_value(row[column_index(letter) - 1])
                if value is not None:
                    entry["metrics"].setdefault(str(year), {})[metric] = value
        expected[ticker] = entry

    args.out.mkdir(parents=True, exist_ok=True)
    target = args.out / "master-software-expected.json"
    target.write_text(json.dumps(expected, indent=1) + "\n")
    print(f"captured {len(expected)} tickers -> {target}")


if __name__ == "__main__":
    main()

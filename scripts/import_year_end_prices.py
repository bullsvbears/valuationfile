#!/usr/bin/env python3
"""
Import a year-end price list into the bundled baselines file.

The file is two columns, ticker and closing price, one row per name. Output
goes to data/year-end-closes.json keyed by year; the server consults this
file before asking the price feed, so hand-supplied baselines win and ship with the
image (they reach a deployed volume without any upload step).

Usage:  python3 scripts/import_year_end_prices.py <prices.xlsx> <year> [--out data/year-end-closes.json]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import openpyxl


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbook", type=Path)
    parser.add_argument("year", type=int)
    parser.add_argument("--out", type=Path, default=Path("data/year-end-closes.json"))
    args = parser.parse_args()

    wb = openpyxl.load_workbook(args.workbook, data_only=True, read_only=True)
    sheet = wb.worksheets[0]

    closes: dict[str, float] = {}
    skipped: list[str] = []
    for row in sheet.iter_rows(min_col=1, max_col=2, values_only=True):
        ticker, price = row
        if not isinstance(ticker, str) or not ticker.strip():
            continue
        ticker = ticker.strip().upper()
        if ticker in ("TICKER", "SYMBOL"):  # a header row, if present
            continue
        if isinstance(price, (int, float)) and not isinstance(price, bool) and price > 0:
            closes[ticker] = round(float(price), 4)
        else:
            skipped.append(ticker)

    existing = json.loads(args.out.read_text()) if args.out.exists() else {}
    existing[str(args.year)] = closes
    args.out.write_text(json.dumps(existing, indent=1, sort_keys=True) + "\n")

    print(f"{len(closes)} closes for {args.year} -> {args.out}")
    if skipped:
        print(f"skipped (no usable price): {', '.join(skipped)}")


if __name__ == "__main__":
    main()

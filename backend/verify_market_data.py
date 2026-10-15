"""Offline smoke check for the v2 market data services.

Hits Yahoo Finance directly (no FastAPI server needed) and prints truncated
JSON so the shapes are readable:

    .venv/bin/python verify_market_data.py
"""

from __future__ import annotations

import json
from typing import Any

from services import market_data

HISTORY_HEAD = 3
HISTORY_TAIL = 2


def _rule(title: str) -> None:
    print(f"\n{'=' * 72}\n{title}\n{'=' * 72}")


def _truncate_history(result: dict[str, Any]) -> dict[str, Any]:
    """Keep the payload printable: first/last few candles, rest elided."""
    history = result.get("history") or []
    if len(history) <= HISTORY_HEAD + HISTORY_TAIL:
        return result

    elided = len(history) - HISTORY_HEAD - HISTORY_TAIL
    shown: list[Any] = [
        *history[:HISTORY_HEAD],
        f"... {elided} more points ...",
        *history[-HISTORY_TAIL:],
    ]
    return {**result, "history": shown}


def _show(payload: Any) -> None:
    print(json.dumps(payload, indent=2, default=str))


def check_search(query: str) -> None:
    _rule(f'search_tickers("{query}")')
    matches = market_data.search_tickers(query)
    print(f"matches: {len(matches)}")
    _show(matches)


def check_profile(ticker: str, period: str = market_data.DEFAULT_PERIOD) -> None:
    _rule(f'fetch_asset_profile("{ticker}", "{period}")')
    result = market_data.fetch_asset_profile(ticker, period)
    history = result.get("history") or []
    print(
        f"status: {result['status']}  interval: {result['interval']}  "
        f"intraday: {result['intraday']}  history points: {len(history)}"
    )
    _show(_truncate_history(result))


def check_ranges(ticker: str) -> None:
    """One line per range: the quickest way to spot a broken interval map."""
    _rule(f'all ranges for "{ticker}"')
    for period in market_data.SUPPORTED_PERIODS:
        result = market_data.fetch_asset_profile(ticker, period)
        if result["status"] != market_data.STATUS_OK:
            print(f"  {period:<4} ERROR {result['message']}")
            continue
        history = result["history"]
        print(
            f"  {period:<4} interval={result['interval']:<4} "
            f"intraday={str(result['intraday']):<5} points={len(history):<4} "
            f"first={history[0]['date'] if history else '-'}"
        )


if __name__ == "__main__":
    check_search("apple")
    check_profile("AAPL")
    # Intraday: the range whose bars need a clock-time axis label.
    check_profile("0700.HK", "1D")
    check_ranges("AAPL")
    check_ranges("0700.HK")
    # Error path: proves the router has something to turn into a 404.
    check_profile("NOTAREALTICKER123")

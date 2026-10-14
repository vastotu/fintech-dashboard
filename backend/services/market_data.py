"""Market data ingestion backed by Yahoo Finance."""

from __future__ import annotations

import yfinance as yf


class MarketDataError(RuntimeError):
    """Raised when market data cannot be retrieved for a ticker."""


def fetch_closing_price(ticker: str) -> float:
    """Return the most recent daily closing price for `ticker`.

    While a session is still open, Yahoo Finance reports the latest trade as
    that day's close, so this doubles as a near-live price during market hours.

    Raises:
        MarketDataError: if the symbol is blank or Yahoo returns no rows.
    """
    symbol = ticker.strip().upper()
    if not symbol:
        raise MarketDataError("Ticker symbol must not be empty.")

    history = yf.Ticker(symbol).history(period="1d")
    if history.empty:
        raise MarketDataError(f"No market data returned for {symbol!r}.")

    return float(history["Close"].iloc[-1])


if __name__ == "__main__":
    SYMBOL = "AAPL"
    try:
        price = fetch_closing_price(SYMBOL)
    except MarketDataError as exc:
        print(f"Fetch failed: {exc}")
    else:
        print(f"{SYMBOL} closing price: ${price:,.2f}")

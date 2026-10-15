"""Market data ingestion backed by Yahoo Finance.

Two entry points:

* `search_tickers` - fuzzy symbol/name lookup for the search box, via Yahoo's
  public search endpoint (no API key).
* `fetch_asset_profile` - quote snapshot plus one month of daily history for
  the asset dashboard, via `yfinance`.

Both degrade gracefully: `search_tickers` returns an empty list and
`fetch_asset_profile` returns a `status: "error"` payload rather than raising,
so a Yahoo outage surfaces as an explainable state instead of a 500.
"""

from __future__ import annotations

import logging
import math
from functools import lru_cache
from typing import Any

import requests
import yfinance as yf

try:  # Ships with yfinance; see _search_payload for why it matters here.
    from curl_cffi import requests as impersonating_requests
except ImportError:  # pragma: no cover - only if yfinance's deps change
    impersonating_requests = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

SEARCH_ENDPOINT = "https://query2.finance.yahoo.com/v1/finance/search"
REQUEST_TIMEOUT_SECONDS = 10
DEFAULT_QUOTES_COUNT = 5
MAX_QUOTES_COUNT = 20
IMPERSONATE_PROFILE = "chrome"

DEFAULT_PERIOD = "1M"

# UI range -> (yfinance period, yfinance interval). The interval is what makes
# a range readable: 5y of daily bars is 1,250 points of mush on a 600px chart,
# and 1d of daily bars is a single dot.
PERIOD_PRESETS: dict[str, tuple[str, str]] = {
    "1D": ("1d", "5m"),
    "1W": ("5d", "15m"),
    "1M": ("1mo", "1d"),
    "3M": ("3mo", "1d"),
    "1Y": ("1y", "1d"),
    "5Y": ("5y", "1wk"),
    "MAX": ("max", "1mo"),
}
SUPPORTED_PERIODS: tuple[str, ...] = tuple(PERIOD_PRESETS)

# Ranges whose bars are intraday, so the UI should label them with a time.
INTRADAY_PERIODS = frozenset({"1D", "1W"})

# Yahoo reports an exchange twice and inconsistently: quotes carry a code
# ("NMS") plus `fullExchangeName` ("NasdaqGS"), while search carries the same
# code plus `exchDisp` ("NASDAQ"). Neither display string matches the other, so
# both endpoints resolve the *code* through this table instead. Values were
# harvested from Yahoo's own `exchDisp` so search stays the source of truth.
EXCHANGE_DISPLAY_NAMES: dict[str, str] = {
    "ASX": "Australian",
    "BSE": "Bombay",
    "BTS": "BATS Trading",
    "BUE": "Buenos Aires",
    "CBT": "Chicago Board of Trade",
    "CME": "Chicago Mercantile Exchange",
    "CMX": "New York Commodity Exchange",
    "DUS": "Dusseldorf Stock Exchange",
    "EBS": "Swiss",
    "FRA": "Frankfurt",
    "GER": "XETRA",
    "HKG": "Hong Kong",
    "IOB": "International Orderbook - London",
    "JNB": "Johannesburg Stock Exchange",
    "JPX": "Tokyo Stock Exchange",
    "KLS": "Kuala Lumpur Stock Exchange",
    "KSC": "Korea",
    "LSE": "London",
    "MUN": "Munich",
    "NAS": "NASDAQ",
    "NGM": "NASDAQ",
    "NMS": "NASDAQ",
    "NSI": "NSE",
    "NYQ": "NYSE",
    "NYS": "NYSE",
    "PCX": "NYSEArca",
    "PNK": "OTC Markets",
    "SAO": "São Paulo",
    "SAU": "Saudi Stock Exchange",
    "SES": "Singapore",
    "TOR": "Toronto",
}

# Yahoo 403s / 429s clients that don't look like browsers, so say so
# explicitly rather than letting the HTTP client advertise python-requests/x.y.
BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
}

# requests.RequestException and curl_cffi's RequestException are unrelated
# hierarchies that both land under OSError; ValueError covers bad JSON.
TRANSPORT_ERRORS: tuple[type[BaseException], ...] = (
    requests.RequestException,
    OSError,
    ValueError,
)

STATUS_OK = "ok"
STATUS_ERROR = "error"

TickerMatch = dict[str, str | None]
HistoryPoint = dict[str, Any]
AssetProfileResult = dict[str, Any]


def _error(message: str, period: str = DEFAULT_PERIOD) -> AssetProfileResult:
    """Failure payload that keeps the success shape, so the UI can key off it."""
    preset = PERIOD_PRESETS.get(period) or PERIOD_PRESETS[DEFAULT_PERIOD]
    return {
        "status": STATUS_ERROR,
        "message": message,
        "period": period,
        "interval": preset[1],
        "intraday": period in INTRADAY_PERIODS,
        "profile": None,
        "history": [],
    }


def _safe_float(value: Any) -> float | None:
    """Coerce a Yahoo/pandas value to float, mapping None and NaN to None."""
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    # NaN and infinities are not JSON-serialisable; treat them as missing.
    return number if math.isfinite(number) else None


def _safe_int(value: Any) -> int | None:
    number = _safe_float(value)
    return None if number is None else int(number)


def _safe_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _round_or_none(value: Any, digits: int = 4) -> float | None:
    number = _safe_float(value)
    return None if number is None else round(number, digits)


def _display_exchange(code: Any, *fallbacks: Any) -> str | None:
    """Resolve a Yahoo exchange code to one canonical display name.

    Shared by `search_tickers` and `fetch_asset_profile` so the same asset
    never reads "NASDAQ" in the dropdown and "NasdaqGS" in the header.
    Unmapped codes fall back to whatever display string Yahoo supplied, then to
    the raw code, so a new exchange degrades to something readable.
    """
    key = _safe_str(code)
    if key and key.upper() in EXCHANGE_DISPLAY_NAMES:
        return EXCHANGE_DISPLAY_NAMES[key.upper()]
    for fallback in fallbacks:
        resolved = _safe_str(fallback)
        if resolved:
            return resolved
    return key


def _search_payload(params: dict[str, Any], term: str) -> dict[str, Any] | None:
    """GET the search endpoint, or None if Yahoo won't talk to us.

    Yahoo gates this endpoint on TLS fingerprint, not just headers: plain
    `requests` gets a blanket 429 even with a browser User-Agent and warmed
    cookies. `curl_cffi` impersonates a real Chrome handshake and gets 200, so
    try it first and keep plain `requests` as a fallback for environments
    where it isn't installed.
    """
    clients: list[tuple[str, Any]] = []
    if impersonating_requests is not None:
        clients.append(("curl_cffi", impersonating_requests))
    clients.append(("requests", requests))

    for name, client in clients:
        kwargs: dict[str, Any] = {}
        if name == "curl_cffi":
            kwargs["impersonate"] = IMPERSONATE_PROFILE
        try:
            response = client.get(
                SEARCH_ENDPOINT,
                params=params,
                headers=BROWSER_HEADERS,
                timeout=REQUEST_TIMEOUT_SECONDS,
                **kwargs,
            )
            if response.status_code != 200:
                logger.warning(
                    "Yahoo search returned HTTP %s for %r via %s.",
                    response.status_code,
                    term,
                    name,
                )
                continue

            payload = response.json()

        except TRANSPORT_ERRORS as exc:
            logger.warning(
                "Yahoo search failed for %r via %s: %s", term, name, exc
            )
            continue

        if isinstance(payload, dict):
            return payload

        logger.warning("Yahoo search returned an unexpected payload for %r.", term)

    return None


def search_tickers(query: str, count: int = DEFAULT_QUOTES_COUNT) -> list[TickerMatch]:
    """Return fuzzy symbol matches for a free-text `query`.

    Matches look like {"symbol": "AAPL", "shortname": "Apple Inc.",
    "exchange": "NASDAQ"}. Accepts company names as well as tickers, which is
    the point: the search box should find "apple" without the user knowing
    AAPL.

    Returns an empty list for a blank query or any upstream failure; the
    failure is logged rather than raised so the search box stays responsive.
    """
    term = query.strip()
    if not term:
        return []

    quotes_count = max(1, min(count, MAX_QUOTES_COUNT))
    payload = _search_payload(
        {
            "q": term,
            "quotesCount": quotes_count,
            # Headlines come from the news service; keep this payload lean.
            "newsCount": 0,
        },
        term,
    )
    if payload is None:
        return []

    quotes = payload.get("quotes")
    if not isinstance(quotes, list):
        return []

    matches: list[TickerMatch] = []
    for quote in quotes:
        if not isinstance(quote, dict):
            continue
        symbol = _safe_str(quote.get("symbol"))
        if not symbol:
            # A row without a symbol can't be charted, so it's not a result.
            continue
        matches.append(
            {
                "symbol": symbol,
                # Indexes and funds often carry longname only.
                "shortname": _safe_str(quote.get("shortname"))
                or _safe_str(quote.get("longname")),
                "exchange": _display_exchange(
                    quote.get("exchange"), quote.get("exchDisp")
                ),
            }
        )
        if len(matches) >= quotes_count:
            break

    return matches


def _column(frame: Any, name: str) -> list[Any]:
    """Column values, or all-None when yfinance omits the column entirely.

    Keeps a missing OHLC column from turning into a KeyError at the call site,
    which would be a 500 for what is really just a thinner payload.
    """
    if name in frame.columns:
        return list(frame[name])
    return [None] * len(frame.index)


@lru_cache(maxsize=256)
def fetch_company_name(ticker: str) -> str | None:
    """Yahoo's display name for `ticker`, or None if it can't be resolved.

    Exists for the news path: NewsAPI indexes prose, so "D05.SI" matches
    nothing while "DBS" matches plenty. Resolving the symbol to a name is the
    bridge between the two.

    Cached because every news and analysis request needs it and a listing's
    name doesn't change within a process lifetime. Returns None rather than
    raising, so a Yahoo outage degrades the news query to the bare symbol
    instead of failing the request.
    """
    symbol = ticker.strip().upper()
    if not symbol:
        return None

    try:
        info: dict[str, Any] = yf.Ticker(symbol).info or {}
    except Exception as exc:  # noqa: BLE001 - yfinance raises loosely typed errors
        logger.warning("Could not resolve a company name for %s: %s", symbol, exc)
        return None

    return _safe_str(info.get("shortName")) or _safe_str(info.get("longName"))


def _build_history(frame: Any) -> list[HistoryPoint]:
    """Flatten a yfinance history DataFrame into chart-ready OHLC points.

    `date` is a full ISO-8601 timestamp, offset included, for every range -
    not a bare "YYYY-MM-DD". Intraday bars need it (78 five-minute bars would
    otherwise collapse onto one "2026-10-15" label), and keeping one shape for
    all ranges means the chart doesn't have to branch on payload format. The
    offset is the exchange's, which is what lets the UI label a Hong Kong bar
    09:30 rather than shifting it into the viewer's timezone.

    Every point carries open/high/low/close/volume, so candlesticks are a
    rendering change rather than another round trip.
    """
    points: list[HistoryPoint] = []
    rows = zip(
        frame.index,
        _column(frame, "Open"),
        _column(frame, "High"),
        _column(frame, "Low"),
        _column(frame, "Close"),
        _column(frame, "Volume"),
        strict=False,
    )

    for timestamp, open_, high, low, close, volume in rows:
        close_price = _safe_float(close)
        if close_price is None:
            # Holiday/halt rows arrive as NaN; a gap is better than a fake 0.
            continue
        points.append(
            {
                "date": timestamp.isoformat(),
                # Close gates the row, but the other legs can still be absent
                # individually, so they stay nullable rather than faked.
                "open": _round_or_none(open_),
                "high": _round_or_none(high),
                "low": _round_or_none(low),
                "close": round(close_price, 4),
                "volume": _safe_int(volume) or 0,
            }
        )
    return points


def fetch_asset_profile(
    ticker: str, period: str = DEFAULT_PERIOD
) -> AssetProfileResult:
    """Return a quote snapshot plus price history for `ticker` over `period`.

    `period` is a UI range key from `SUPPORTED_PERIODS` ("1D", "1W", "1M",
    "3M", "1Y", "5Y", "MAX"), resolved to a yfinance period/interval pair by
    `PERIOD_PRESETS`. Unknown keys fall back to the default rather than
    failing, so a stale client still renders a chart.

    On success:
        {"status": "ok", "message": None, "period": "1M", "interval": "1d",
         "intraday": False,
         "profile": {"symbol", "name", "exchange", "currency", "timezone",
                     "current_price", "change_percent", "volume", "prev_close",
                     "market_cap", "pe_ratio", "eps", "day_low", "day_high",
                     "fifty_two_week_low", "fifty_two_week_high",
                     "dividend_yield", "average_volume"},
         "history": [{"date": <ISO-8601>, "open", "high", "low",
                      "close": 150.5, "volume": 12000}, ...]}

    Every numeric field is nullable. An absent metric is reported as null, not
    as a placeholder string, so the client decides how "missing" renders.

    On a blank/unknown symbol or an upstream failure:
        {"status": "error", "message": <why>, "profile": None, "history": []}

    `change_percent` is a percentage (0.5 means +0.5%), matching Yahoo's
    `regularMarketChangePercent`. Works for international symbols too, e.g.
    "0700.HK" - Yahoo keys those off the exchange suffix.
    """
    symbol = ticker.strip().upper()
    if not symbol:
        logger.warning("fetch_asset_profile called with a blank ticker.")
        return _error("Ticker symbol must not be empty.")

    range_key = (period or "").strip().upper() or DEFAULT_PERIOD
    if range_key not in PERIOD_PRESETS:
        logger.warning(
            "Unsupported period %r; falling back to %s.", period, DEFAULT_PERIOD
        )
        range_key = DEFAULT_PERIOD
    yf_period, yf_interval = PERIOD_PRESETS[range_key]

    try:
        handle = yf.Ticker(symbol)
    except Exception as exc:  # noqa: BLE001 - yfinance raises loosely typed errors
        logger.warning("Could not open a Yahoo session for %s: %s", symbol, exc)
        return _error(f"Market data lookup failed for {symbol}.", range_key)

    # `info` and `history` fail independently: an unknown symbol usually breaks
    # both, but a flaky quote endpoint shouldn't cost us a usable chart.
    try:
        info: dict[str, Any] = handle.info or {}
    except Exception as exc:  # noqa: BLE001 - yfinance raises loosely typed errors
        logger.warning("Quote lookup failed for %s: %s", symbol, exc)
        info = {}

    try:
        frame = handle.history(period=yf_period, interval=yf_interval)
    except Exception as exc:  # noqa: BLE001 - yfinance raises loosely typed errors
        logger.warning(
            "History lookup failed for %s (%s/%s): %s",
            symbol,
            yf_period,
            yf_interval,
            exc,
        )
        frame = None

    history = [] if frame is None or frame.empty else _build_history(frame)

    profile = _build_profile(symbol, info, history)
    if profile is None:
        logger.info("No market data returned for %s.", symbol)
        return _error(f"No market data found for {symbol!r}.", range_key)

    return {
        "status": STATUS_OK,
        "message": None,
        "period": range_key,
        "interval": yf_interval,
        "intraday": range_key in INTRADAY_PERIODS,
        "profile": profile,
        "history": history,
    }


def fetch_quote_profile(ticker: str) -> AssetProfileResult:
    """Quote snapshot for `ticker` with no price history.

    Same profile shape as `fetch_asset_profile`, minus the chart. The
    sentiment path needs the KPIs to reason over but never plots them, and
    skipping the history request saves a Yahoo round trip on an endpoint that
    is already waiting on an LLM call.
    """
    symbol = ticker.strip().upper()
    if not symbol:
        return {
            "status": STATUS_ERROR,
            "message": "Ticker symbol must not be empty.",
            "profile": None,
        }

    try:
        info: dict[str, Any] = yf.Ticker(symbol).info or {}
    except Exception as exc:  # noqa: BLE001 - yfinance raises loosely typed errors
        logger.warning("Quote lookup failed for %s: %s", symbol, exc)
        info = {}

    # No history to fall back on here, so a quote-endpoint failure genuinely
    # means no snapshot.
    profile = _build_profile(symbol, info, [])
    if profile is None:
        return {
            "status": STATUS_ERROR,
            "message": f"No quote data found for {symbol!r}.",
            "profile": None,
        }

    return {"status": STATUS_OK, "message": None, "profile": profile}


def _build_profile(
    symbol: str, info: dict[str, Any], history: list[HistoryPoint]
) -> dict[str, Any] | None:
    """Assemble the profile block, or None when there's nothing usable.

    Shared by `fetch_asset_profile` and `fetch_quote_profile` so the KPI set
    can't drift between the chart endpoint and the sentiment engine. `history`
    is optional context: when present it backfills fields the quote endpoint
    sometimes omits.
    """
    current_price = _safe_float(info.get("regularMarketPrice"))
    prev_close = _safe_float(info.get("previousClose")) or _safe_float(
        info.get("regularMarketPreviousClose")
    )

    # Fall back to the chart when the quote endpoint is unhelpful, so a partial
    # upstream failure still renders.
    if current_price is None and history:
        current_price = history[-1]["close"]
    if prev_close is None and len(history) > 1:
        prev_close = history[-2]["close"]

    if current_price is None and not history:
        return None

    change_percent = _safe_float(info.get("regularMarketChangePercent"))
    if change_percent is None and current_price is not None and prev_close:
        change_percent = (current_price - prev_close) / prev_close * 100

    # Explicit None check, not `or`: a halted session really can report 0.
    volume = _safe_int(info.get("regularMarketVolume"))
    if volume is None and history:
        volume = history[-1]["volume"]

    profile = {
        "symbol": symbol,
        "name": _safe_str(info.get("shortName"))
        or _safe_str(info.get("longName"))
        or symbol,
        # Same resolver as the search endpoint, so the dropdown and the header
        # agree on "NASDAQ" instead of disagreeing via "NasdaqGS".
        "exchange": _display_exchange(
            info.get("exchange"), info.get("fullExchangeName")
        ),
        "currency": _safe_str(info.get("currency")),
        # The exchange's timezone, so intraday bars can be labelled in market
        # time rather than drifting with whoever is looking at the chart.
        "timezone": _safe_str(info.get("exchangeTimezoneName")),
        "current_price": current_price,
        "change_percent": None if change_percent is None else round(change_percent, 4),
        "volume": volume,
        "prev_close": prev_close,
        # --- valuation / range KPIs -------------------------------------
        # Missing values stay null rather than becoming "N/A": these are
        # numbers, and the display placeholder is the UI's business. Typing a
        # numeric field as number-or-string would poison every formatter and
        # block ever charting or comparing these.
        "market_cap": _safe_int(info.get("marketCap")),
        "pe_ratio": _round_or_none(info.get("trailingPE"), 2),
        "eps": _round_or_none(info.get("trailingEps"), 2),
        "day_low": _round_or_none(info.get("regularMarketDayLow")),
        "day_high": _round_or_none(info.get("regularMarketDayHigh")),
        "fifty_two_week_low": _round_or_none(info.get("fiftyTwoWeekLow")),
        "fifty_two_week_high": _round_or_none(info.get("fiftyTwoWeekHigh")),
        # Already a percentage in yfinance 1.7 (AAPL reports 0.32 for 0.32%,
        # corroborated by trailingAnnualDividendYield 0.00308). Verified rather
        # than assumed, because treating it as a fraction and scaling by 100
        # would advertise Apple at a 32% yield.
        "dividend_yield": _round_or_none(info.get("dividendYield"), 4),
        "average_volume": _safe_int(info.get("averageVolume"))
        or _safe_int(info.get("averageDailyVolume3Month"))
        or _safe_int(info.get("averageVolume10days")),
    }

    return profile


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    for match in search_tickers("apple"):
        exchange = match["exchange"] or "-"
        print(f"{match['symbol']:<12} {exchange:<10} {match['shortname']}")

    for range_key in SUPPORTED_PERIODS:
        result = fetch_asset_profile("AAPL", range_key)
        if result["status"] != STATUS_OK:
            print(f"{range_key}: {result['message']}")
            continue
        snapshot = result["profile"]
        points = result["history"]
        print(
            f"{range_key:<4} interval={result['interval']:<4} "
            f"points={len(points):<5} "
            f"{snapshot['name']} ({snapshot['exchange']}) "
            f"{snapshot['current_price']} {snapshot['currency']} "
            f"{snapshot['change_percent']:+.2f}%  "
            f"first={points[0]['date'] if points else '-'}"
        )

"""Supabase persistence for search history and watchlists.

Optional by design. The dashboard's core job - quotes, charts, news, sentiment
- works without a database, so nothing here is allowed to break a request.
Every entry point degrades to a no-op when Supabase isn't configured, isn't
installed, or isn't reachable, and says so in the logs rather than raising.

Expected table (create in the Supabase SQL editor before wiring this up):

    create table if not exists search_history (
        id           bigint generated always as identity primary key,
        ticker       text not null,
        company_name text,
        created_at   timestamptz not null default now()
    );
    create index if not exists search_history_ticker_idx
        on search_history (ticker);
    create index if not exists search_history_created_at_idx
        on search_history (created_at desc);

`created_at` is defaulted in the database on purpose: server time is the one
clock every writer agrees on, so rows stay orderable regardless of the
app server's timezone or drift.
"""

from __future__ import annotations

import logging
import os
from functools import lru_cache
from typing import Any

from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

SEARCH_HISTORY_TABLE = "search_history"

DEFAULT_HISTORY_LIMIT = 5
MAX_HISTORY_LIMIT = 50

# PostgREST has no DISTINCT ON, so de-duplication happens in Python over an
# over-fetched window. Someone refreshing AAPL ten times would otherwise fill
# the whole "recent searches" list with one ticker; pulling 6x the requested
# rows leaves room to collapse repeats and still return a full list.
HISTORY_OVERFETCH = 6

# `.env.example` ships these as "your_supabase_url_here". A developer who
# copies the template without filling it in would otherwise build a client
# around a junk URL and get a confusing failure on every insert, so a
# placeholder counts as unconfigured. Mirrors the NEWSAPI/GEMINI convention.
PLACEHOLDER_PREFIX = "your_"

# Guarded even though supabase is pinned in requirements.txt: a slim image or
# a partial install should disable persistence, not take down the API.
try:
    from supabase import create_client
except ImportError:  # pragma: no cover - depends on the deployed image
    create_client = None  # type: ignore[assignment]


def _usable(value: str | None) -> bool:
    """True when an env var holds a real value rather than a template stub."""
    if not value:
        return False
    cleaned = value.strip()
    return bool(cleaned) and not cleaned.startswith(PLACEHOLDER_PREFIX)


@lru_cache(maxsize=1)
def get_client() -> Any | None:
    """Return a Supabase client, or None when persistence is unavailable.

    Built lazily on first use rather than at import time, so importing this
    module can never fail a cold start. The result - including None - is
    cached, which means a missing-config message is logged once instead of on
    every request. Adding credentials therefore needs a process restart, which
    is the normal lifecycle for configuration anyway.
    """
    if create_client is None:
        logger.warning("supabase is not installed; persistence is disabled.")
        return None

    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_KEY")

    if not _usable(url) or not _usable(key):
        logger.info(
            "SUPABASE_URL/SUPABASE_KEY are unset or still placeholders; "
            "persistence is disabled."
        )
        return None

    try:
        client = create_client(url, key)  # type: ignore[arg-type]
    except Exception as exc:  # noqa: BLE001 - supabase raises loosely typed errors
        # A malformed URL or key fails here. Disable rather than crash: the
        # dashboard is still fully usable without a database.
        logger.error("Could not initialise the Supabase client: %s", exc)
        return None

    logger.info("Supabase client initialised.")
    return client


def is_enabled() -> bool:
    """Whether writes will actually be persisted. Useful for health checks."""
    return get_client() is not None


def log_search(ticker: str, company_name: str | None = None) -> bool:
    """Record a ticker lookup in `search_history`.

    Returns True when the row was written, False when it was skipped or the
    write failed. The boolean exists so a caller can surface the state if it
    wants to; ignoring it is also correct, because this is analytics and must
    never affect the market-data response.

    `company_name` is optional because the news resolver legitimately returns
    None for symbols Yahoo can't name, and a missing name shouldn't block
    recording that the search happened.
    """
    # str() rather than a bare `or ""`: this runs as a background task, where
    # an AttributeError on an unexpected type would surface detached from the
    # request that caused it. Coercing keeps the function total.
    symbol = str(ticker or "").strip().upper()
    if not symbol:
        logger.warning("log_search called with a blank ticker.")
        return False

    client = get_client()
    if client is None:
        return False

    name = str(company_name).strip() if company_name is not None else None
    name = name or None

    try:
        # created_at is left to the database default.
        client.table(SEARCH_HISTORY_TABLE).insert(
            {"ticker": symbol, "company_name": name}
        ).execute()
    except Exception as exc:  # noqa: BLE001 - network, auth and schema errors
        # Swallowed on purpose. A missing table or an expired key must not turn
        # a working quote lookup into a 500.
        logger.warning("Could not log a search for %s: %s", symbol, exc)
        return False

    return True


def _dedupe_by_ticker(
    rows: list[dict[str, Any]], limit: int
) -> list[dict[str, Any]]:
    """Collapse history rows to the newest entry per ticker.

    Relies on `rows` arriving newest-first, so the first sighting of a ticker
    is the one kept. Dict insertion order preserves that recency ordering.
    """
    newest: dict[str, dict[str, Any]] = {}

    for row in rows:
        if not isinstance(row, dict):
            continue
        ticker = str(row.get("ticker") or "").strip().upper()
        if not ticker or ticker in newest:
            continue
        newest[ticker] = {
            "ticker": ticker,
            "company_name": row.get("company_name"),
            "created_at": row.get("created_at"),
        }
        if len(newest) >= limit:
            break

    return list(newest.values())


def get_recent_searches(
    limit: int = DEFAULT_HISTORY_LIMIT,
) -> list[dict[str, Any]]:
    """Most recently searched tickers, newest first, one row per ticker.

    Returns [] when Supabase is unconfigured, unreachable, or the query fails,
    so the caller can render an empty list without special-casing an outage.
    That does mean "no searches yet" and "no database" look alike to a
    consumer of this function; `is_enabled()` distinguishes them, and the
    /api/history route reports it.
    """
    client = get_client()
    if client is None:
        return []

    count = max(1, min(limit, MAX_HISTORY_LIMIT))

    try:
        response = (
            client.table(SEARCH_HISTORY_TABLE)
            .select("ticker, company_name, created_at")
            .order("created_at", desc=True)
            .limit(count * HISTORY_OVERFETCH)
            .execute()
        )
    except Exception as exc:  # noqa: BLE001 - network, auth and schema errors
        logger.warning("Could not read search history: %s", exc)
        return []

    rows = getattr(response, "data", None) or []
    if not isinstance(rows, list):
        logger.warning("Unexpected search history payload: %r", type(rows))
        return []

    return _dedupe_by_ticker(rows, count)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    print(f"persistence enabled: {is_enabled()}")
    print(f"log_search('AAPL', 'Apple'): {log_search('AAPL', 'Apple')}")
    print(f"log_search('D05.SI', None): {log_search('D05.SI', None)}")
    # Guard paths: none of these should raise.
    print(f"log_search('', 'nobody'):   {log_search('', 'nobody')}")
    print(f"recent searches:            {get_recent_searches()}")

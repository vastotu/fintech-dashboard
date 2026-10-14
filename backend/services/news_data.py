"""News ingestion backed by NewsAPI."""

from __future__ import annotations

import logging
import os

import requests
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

NEWSAPI_ENDPOINT = "https://newsapi.org/v2/everything"
PLACEHOLDER_KEY = "your_newsapi_key_here"
REQUEST_TIMEOUT_SECONDS = 10
MAX_PAGE_SIZE = 100

STATUS_OK = "ok"
STATUS_ERROR = "error"

Article = dict[str, str | None]
NewsResult = dict[str, object]


def _ok(articles: list[Article]) -> NewsResult:
    return {"status": STATUS_OK, "message": None, "articles": articles}


def _error(message: str) -> NewsResult:
    return {"status": STATUS_ERROR, "message": message, "articles": []}


def fetch_recent_news(ticker: str, limit: int = 5) -> NewsResult:
    """Return recent English articles mentioning `ticker`, with an explicit status.

    Returns {"status": "ok", "message": None, "articles": [...]} on success, and
    {"status": "error", "message": <why>, "articles": []} on failure.

    The status field exists so callers can tell "this ticker has no recent
    coverage" (ok, empty list) apart from "the news feed is broken" (error).
    An earlier version collapsed both into an empty list, which left the
    dashboard unable to explain itself.
    """
    symbol = ticker.strip().upper()
    if not symbol:
        logger.warning("fetch_recent_news called with a blank ticker.")
        return _error("No ticker symbol supplied.")

    api_key = os.getenv("NEWSAPI_KEY")
    if not api_key or api_key == PLACEHOLDER_KEY:
        logger.warning("NEWSAPI_KEY is unset or still the placeholder value.")
        return _error("NEWSAPI_KEY is not configured.")

    page_size = max(1, min(limit, MAX_PAGE_SIZE))

    try:
        response = requests.get(
            NEWSAPI_ENDPOINT,
            params={
                "q": symbol,
                "language": "en",
                "sortBy": "publishedAt",
                "pageSize": page_size,
            },
            # Header auth keeps the key out of URLs, proxy logs and tracebacks.
            headers={"X-Api-Key": api_key},
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        payload = response.json()

    except requests.HTTPError as exc:
        status_code = exc.response.status_code if exc.response is not None else None
        if status_code == 429:
            logger.warning("NewsAPI rate limited for %s.", symbol)
            return _error("NewsAPI rate limited or down.")
        if status_code in (401, 403):
            logger.error("NewsAPI rejected the credentials (HTTP %s).", status_code)
            return _error("NewsAPI rejected the API key.")
        logger.warning("NewsAPI returned HTTP %s for %s.", status_code, symbol)
        return _error(f"NewsAPI returned HTTP {status_code}.")

    except requests.Timeout:
        logger.warning("NewsAPI timed out for %s.", symbol)
        return _error("NewsAPI request timed out.")

    except requests.RequestException as exc:
        logger.warning("NewsAPI request failed for %s: %s", symbol, exc)
        return _error("NewsAPI rate limited or down.")

    except ValueError as exc:
        logger.warning("NewsAPI returned malformed JSON for %s: %s", symbol, exc)
        return _error("NewsAPI returned a malformed response.")

    if payload.get("status") != "ok":
        detail = payload.get("message") or "unspecified error"
        logger.warning("NewsAPI rejected the query for %s: %s", symbol, detail)
        return _error(f"NewsAPI rejected the query: {detail}")

    raw_articles = payload.get("articles") or []
    articles: list[Article] = [
        {
            "title": article.get("title"),
            "source": (article.get("source") or {}).get("name"),
            "publishedAt": article.get("publishedAt"),
            "url": article.get("url"),
        }
        for article in raw_articles[:page_size]
    ]

    # An empty list here is a real answer, not a failure: the query succeeded
    # and this ticker simply has no recent English coverage.
    return _ok(articles)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    SYMBOL = "AAPL"
    result = fetch_recent_news(SYMBOL)
    print(f"status: {result['status']}  message: {result['message']}")

    items = result["articles"]
    if not items:
        print(f"No articles returned for {SYMBOL}.")
    for item in items:  # type: ignore[union-attr]
        print(f"[{item['publishedAt']}] {item['source']}: {item['title']}")

"""News ingestion backed by NewsAPI."""

from __future__ import annotations

import logging
import os
import re

import requests
from dotenv import load_dotenv

from services import market_data

load_dotenv()

logger = logging.getLogger(__name__)

NEWSAPI_ENDPOINT = "https://newsapi.org/v2/everything"
PLACEHOLDER_KEY = "your_newsapi_key_here"
REQUEST_TIMEOUT_SECONDS = 10
MAX_PAGE_SIZE = 100

# Sample size for the sentiment engine. Five headlines let one off-topic story
# swing the score; thirty give the model enough to average over and enough
# redundancy that discarding the irrelevant ones still leaves a signal.
ANALYSIS_PAGE_SIZE = 30

# Match headline and summary only, never the article body. Body matching was
# the biggest source of wrong-entity results: querying "DBS" surfaced Barclays
# stories that merely mention DBS in passing, and the sentiment model then
# scored Barclays news as DBS sentiment.
NEWSAPI_SEARCH_FIELDS = "title,description"

# Package indexes and code hosts are in NewsAPI's index but publish no
# financial reporting. "tencentcloud-sdk-python-intl-en 3.1.186" is a release
# notification, not a market signal, and it skews the sentiment read.
EXCLUDED_DOMAINS = (
    "pypi.org",
    "github.com",
    "gitlab.com",
    "npmjs.com",
    "sourceforge.net",
    "readthedocs.io",
    "hackernoon.com",
)

STATUS_OK = "ok"
STATUS_ERROR = "error"

# Trailing legal-entity noise. NewsAPI matches prose, and reporters write
# "Tencent", not "Tencent Holdings Ltd", so these words only narrow the search.
# Ordering is irrelevant: stripping runs to a fixed point, which is what peels
# the three layers off "DBS Group Holdings Ltd".
CORPORATE_SUFFIXES = (
    "incorporated",
    "inc",
    "corporation",
    "corp",
    "company",
    "co",
    "limited",
    "ltd",
    "holdings",
    "holding",
    "group",
    "plc",
    "llc",
    "llp",
    "lp",
    "ag",
    "sa",
    "nv",
    "se",
    "ab",
    "asa",
    "oyj",
    "spa",
    "bhd",
    "berhad",
    "tbk",
    "pjsc",
    "jsc",
    "pcl",
    "pte",
    "pvt",
    "private",
    "reit",
    "adr",
    "ads",
    "ord",
    "shs",
)

# A leading separator is required rather than \b, so a company whose whole
# name is a suffix word survives: " Group" in "DBS Group" matches, but the
# standalone name "Group" does not and is returned untouched.
_SUFFIX_RE = re.compile(
    r"[\s,]+(?:" + "|".join(CORPORATE_SUFFIXES) + r")\.?\s*$",
    re.IGNORECASE,
)
# Dotted entity abbreviations the word list can't catch, because the periods
# sit inside the token: "Nestle S.A.", "Philips N.V.", "Campari S.p.A.".
_DOTTED_SUFFIX_RE = re.compile(r"[\s,]+(?:[a-z]\.){2,}\s*$", re.IGNORECASE)

# Share-class tails: "Alphabet Inc Class A", "... Series B".
_SHARE_CLASS_RE = re.compile(
    r"[\s,]+(?:class|series|cl)\s+[a-z0-9]\.?\s*$",
    re.IGNORECASE,
)

# London-style share descriptors, e.g. Yahoo reports BARC.L as "BARCLAYS PLC
# ORD 25P" (ordinary shares, 25p par). The par value never appears in prose,
# so everything from the marker onward is listing plumbing and goes with it.
# Deliberately short and unambiguous: "dr" was excluded because it would
# reduce "Keurig Dr Pepper" to "Keurig".
_SHARE_DESCRIPTOR_RE = re.compile(
    r"[\s,]+(?:ord|npv|shs|cls|reg)\b.*$",
    re.IGNORECASE,
)

# Punctuation left dangling once a suffix is removed.
_TRAILING_JUNK_RE = re.compile(r"[\s,&.\-]+$")

# Swiss/Nordic registered-share markers: Yahoo reports NESN.SW as "NESTLE N".
# A lone trailing letter is a share class, never part of the name. Applied
# once at the end under a length guard rather than inside the loop, so it can
# never nibble a short name down to nothing.
_TRAILING_LETTER_RE = re.compile(r"[\s,]+[a-z]\.?\s*$", re.IGNORECASE)
MIN_LETTER_STRIP_LENGTH = 3

# "DBS Group Holdings Ltd" needs three passes; the cap only stops a pathological
# name from looping, since each pass must shrink the string to continue.
MAX_SUFFIX_PASSES = 6
# Below this, a "name" is too generic to search usefully, so keep the original.
MIN_NAME_LENGTH = 2

Article = dict[str, str | None]
NewsResult = dict[str, object]


def strip_corporate_suffixes(name: str) -> str:
    """Reduce a legal entity name to the name reporters actually print.

    "Apple Inc."                 -> "Apple"
    "Tencent Holdings Ltd"       -> "Tencent"
    "DBS Group Holdings Ltd"     -> "DBS"
    "Marks & Spencer Group plc"  -> "Marks & Spencer"
    "BARCLAYS PLC ORD 25P"       -> "BARCLAYS"
    "Nestle S.A."                -> "Nestle"
    "NESTLE N"                   -> "NESTLE"

    Runs to a fixed point because real names stack several suffixes. Falls back
    to the input whenever stripping would leave nothing searchable, so a name
    made entirely of suffix words is never reduced to an empty query.
    """
    cleaned = name.strip()

    for _ in range(MAX_SUFFIX_PASSES):
        previous = cleaned
        cleaned = _SHARE_DESCRIPTOR_RE.sub("", cleaned)
        cleaned = _SHARE_CLASS_RE.sub("", cleaned)
        cleaned = _DOTTED_SUFFIX_RE.sub("", cleaned)
        cleaned = _SUFFIX_RE.sub("", cleaned)
        cleaned = _TRAILING_JUNK_RE.sub("", cleaned)
        if cleaned == previous:
            break

    candidate = _TRAILING_LETTER_RE.sub("", cleaned)
    if len(candidate) >= MIN_LETTER_STRIP_LENGTH:
        cleaned = candidate

    return cleaned if len(cleaned) >= MIN_NAME_LENGTH else name.strip()


def build_news_query(ticker: str) -> tuple[str, str | None]:
    """Resolve `ticker` to a (NewsAPI query, display company name) pair.

    This is the fix for international coverage: a symbol like "D05.SI" or
    "0700.HK" appears in no article body, so querying it returned an empty but
    successful result that was indistinguishable from quiet coverage. Resolving
    through Yahoo's company name gives the index something to match.

    The name is always quoted, so NewsAPI treats it as an exact phrase.
    Unquoted, "Marks & Spencer" matches any article containing either word,
    and even a single token matches more loosely than intended.

    Falls back to the bare symbol when the name can't be resolved, which is no
    worse than the previous behaviour.
    """
    symbol = ticker.strip().upper()
    resolved = market_data.fetch_company_name(symbol)

    if not resolved:
        logger.info("No company name for %s; querying the symbol itself.", symbol)
        return symbol, None

    company = strip_corporate_suffixes(resolved)
    query = f'"{company}"'
    logger.info("Resolved %s -> %r (query %s).", symbol, company, query)
    return query, company


def _ok(articles: list[Article], query: str, company: str | None) -> NewsResult:
    return {
        "status": STATUS_OK,
        "message": None,
        "query": query,
        "company": company,
        "articles": articles,
    }


def _error(
    message: str, query: str | None = None, company: str | None = None
) -> NewsResult:
    return {
        "status": STATUS_ERROR,
        "message": message,
        "query": query,
        "company": company,
        "articles": [],
    }


def fetch_recent_news(ticker: str, limit: int = 5) -> NewsResult:
    """Return recent English articles about `ticker`, with an explicit status.

    Searches by resolved company name rather than by symbol - see
    `build_news_query`. The returned `query` and `company` fields report what
    was actually searched, so an empty result is explainable rather than
    mysterious.

    Returns {"status": "ok", "message": None, ...} on success and
    {"status": "error", "message": <why>, ...} on failure.

    The status field exists so callers can tell "this company has no recent
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

    query, company = build_news_query(symbol)
    page_size = max(1, min(limit, MAX_PAGE_SIZE))

    try:
        response = requests.get(
            NEWSAPI_ENDPOINT,
            params={
                "q": query,
                "searchIn": NEWSAPI_SEARCH_FIELDS,
                "excludeDomains": ",".join(EXCLUDED_DOMAINS),
                # Kept to English: the sentiment model reads these headlines,
                # and English-language wires carry global listings anyway
                # (Reuters and the Straits Times both cover DBS).
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
            return _error("NewsAPI rate limited or down.", query, company)
        if status_code in (401, 403):
            logger.error("NewsAPI rejected the credentials (HTTP %s).", status_code)
            return _error("NewsAPI rejected the API key.", query, company)
        logger.warning("NewsAPI returned HTTP %s for %s.", status_code, symbol)
        return _error(f"NewsAPI returned HTTP {status_code}.", query, company)

    except requests.Timeout:
        logger.warning("NewsAPI timed out for %s.", symbol)
        return _error("NewsAPI request timed out.", query, company)

    except requests.RequestException as exc:
        logger.warning("NewsAPI request failed for %s: %s", symbol, exc)
        return _error("NewsAPI rate limited or down.", query, company)

    except ValueError as exc:
        logger.warning("NewsAPI returned malformed JSON for %s: %s", symbol, exc)
        return _error("NewsAPI returned a malformed response.", query, company)

    if payload.get("status") != "ok":
        detail = payload.get("message") or "unspecified error"
        logger.warning("NewsAPI rejected the query for %s: %s", symbol, detail)
        return _error(f"NewsAPI rejected the query: {detail}", query, company)

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
    # and this company simply has no recent English coverage.
    return _ok(articles, query, company)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    # D05.SI and 0700.HK are the cases that motivated name resolution: both
    # return nothing when queried as symbols.
    for symbol in ("AAPL", "0700.HK", "D05.SI"):
        result = fetch_recent_news(symbol)
        print(
            f"\n{symbol}: status={result['status']} "
            f"company={result['company']!r} query={result['query']!r} "
            f"message={result['message']}"
        )

        items = result["articles"]
        if not items:
            print("   no articles returned")
        for item in items:  # type: ignore[union-attr]
            print(f"   [{item['publishedAt']}] {item['source']}: {item['title']}")

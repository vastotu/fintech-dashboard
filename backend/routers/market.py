"""REST routes for market prices and ticker news."""

from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query

from services import db, market_data, news_data, sentiment

router = APIRouter(tags=["market"])

# The model reads the full 30-article sample; the dashboard shows this many.
# Rendering thirty cards buried the chart, and the extra articles were only
# ever there to give the sentiment engine something to average over.
DISPLAY_ARTICLE_LIMIT = 5


# Sync `def` on purpose: both services block on network I/O, so FastAPI runs
# them in its threadpool instead of stalling the event loop.
@router.get("/search")
def search(
    q: str = Query(min_length=1, max_length=64, description="Ticker or company name"),
    limit: int = Query(default=5, ge=1, le=20),
) -> dict[str, object]:
    """Fuzzy ticker lookup for the search box.

    Responds 200 with an empty list both when nothing matches and when Yahoo
    is unreachable: a type-ahead that throws mid-keystroke is worse than one
    that briefly comes up empty.
    """
    results = market_data.search_tickers(q, count=limit)

    return {
        "query": q.strip(),
        "count": len(results),
        "results": results,
    }


@router.get("/asset/{ticker}")
def get_asset(
    ticker: str,
    background_tasks: BackgroundTasks,
    period: str = Query(
        default=market_data.DEFAULT_PERIOD,
        description=f"Chart range: {', '.join(market_data.SUPPORTED_PERIODS)}",
    ),
) -> dict[str, object]:
    """Quote snapshot plus price history for a ticker over the given range."""
    symbol = ticker.strip().upper()
    range_key = period.strip().upper()

    # 400, not 404: the symbol may be perfectly valid and only the range is
    # wrong, so don't let a typo'd period look like a missing asset.
    if range_key not in market_data.SUPPORTED_PERIODS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported period {period!r}. "
                f"Valid values: {', '.join(market_data.SUPPORTED_PERIODS)}."
            ),
        )

    result = market_data.fetch_asset_profile(ticker, range_key)

    # Unlike /search, a dashboard with no asset has nothing to render, so an
    # unknown symbol is a 404 rather than an empty 200.
    if result["status"] == market_data.STATUS_ERROR:
        raise HTTPException(status_code=404, detail=str(result["message"]))

    profile: dict[str, object] = result["profile"]  # type: ignore[assignment]

    # Queued, not awaited: Starlette runs this after the response is flushed,
    # so a Supabase round trip never lands on the dashboard's load time. Only
    # logged past the 404 guard, so history records real resolved assets
    # rather than every typo on the way to one.
    background_tasks.add_task(
        db.log_search,
        ticker=symbol,
        company_name=profile.get("name", "Unknown"),
    )

    return {
        "ticker": symbol,
        "status": result["status"],
        "period": result["period"],
        "interval": result["interval"],
        "intraday": result["intraday"],
        "profile": profile,
        "history": result["history"],
    }


@router.get("/history")
def get_history(
    limit: int = Query(default=db.DEFAULT_HISTORY_LIMIT, ge=1, le=db.MAX_HISTORY_LIMIT),
) -> dict[str, object]:
    """Recently searched tickers, newest first and de-duplicated.

    Always 200. `persistence` distinguishes the two ways `history` can come
    back empty: nobody has searched yet, or Supabase isn't configured.
    """
    history = db.get_recent_searches(limit)

    return {
        "status": "ok",
        "persistence": db.is_enabled(),
        "count": len(history),
        "history": history,
    }


@router.get("/news/{ticker}")
def get_news(ticker: str, limit: int = Query(default=5, ge=1, le=100)) -> dict[str, object]:
    """Recent headlines mentioning a ticker.

    Responds 200 even when the upstream feed fails: `status` carries that
    detail so the client can tell an outage from genuinely quiet coverage.
    """
    result = news_data.fetch_recent_news(ticker, limit=limit)
    articles = result["articles"]

    return {
        "ticker": ticker.strip().upper(),
        "status": result["status"],
        "message": result["message"],
        # What was actually searched. Non-US symbols are looked up by company
        # name, so echoing it back makes an empty result explainable.
        "company": result["company"],
        "query": result["query"],
        "count": len(articles),  # type: ignore[arg-type]
        "articles": articles,
    }


@router.get("/analysis/{ticker}")
def get_analysis(
    ticker: str,
    limit: int = Query(default=news_data.ANALYSIS_PAGE_SIZE, ge=1, le=100),
) -> dict[str, object]:
    """Multi-factor sentiment: headlines plus the asset's market snapshot.

    Both upstreams are fetched before the model runs, because the score is
    meant to weigh news against technicals and fundamentals. A quote failure
    is survivable (the model is told the data is missing and scores on news
    alone); a news failure is not, since there would be nothing to read.
    """
    news = news_data.fetch_recent_news(ticker, limit=limit)
    articles = news["articles"]
    news_failed = news["status"] == news_data.STATUS_ERROR

    quote = market_data.fetch_quote_profile(ticker)
    profile = quote["profile"] if quote["status"] == market_data.STATUS_OK else None

    # Don't ask the model to read headlines we never got. Without this, a news
    # outage would yield a confident-looking neutral 50 instead of an error.
    if news_failed:
        analysis = sentiment.unavailable(
            f"Sentiment analysis unavailable: news feed failed ({news['message']})."
        )
    else:
        # The full sample, deliberately: scoring quality comes from breadth,
        # and Rule 1 needs spare articles to discard.
        analysis = sentiment.analyze_news_sentiment(
            articles,  # type: ignore[arg-type]
            profile,  # type: ignore[arg-type]
        )

    # Trim for display only, after the model has read everything.
    displayed = articles[:DISPLAY_ARTICLE_LIMIT]  # type: ignore[index]

    return {
        "ticker": ticker.strip().upper(),
        "news_status": news["status"],
        "news_message": news["message"],
        "company": news["company"],
        "news_query": news["query"],
        # Counts the list actually returned, so the UI's "N articles" label
        # matches the cards beside it.
        "news_count": len(displayed),
        # How many the model actually weighed. Without this the response would
        # imply the score came from five headlines.
        "news_analyzed": len(articles),  # type: ignore[arg-type]
        # Lets the client tell "scored without fundamentals" apart from a
        # genuinely neutral read.
        "profile_status": quote["status"],
        "sentiment_analysis": analysis,
        "articles": displayed,
    }

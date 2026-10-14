"""REST routes for market prices and ticker news."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from services import market_data, news_data, sentiment

router = APIRouter(tags=["market"])


# Sync `def` on purpose: both services block on network I/O, so FastAPI runs
# them in its threadpool instead of stalling the event loop.
@router.get("/asset/{ticker}")
def get_asset(ticker: str) -> dict[str, object]:
    """Latest daily close for a ticker."""
    try:
        price = market_data.fetch_closing_price(ticker)
    except market_data.MarketDataError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return {"ticker": ticker.strip().upper(), "close": price}


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
        "count": len(articles),  # type: ignore[arg-type]
        "articles": articles,
    }


@router.get("/analysis/{ticker}")
def get_analysis(ticker: str, limit: int = Query(default=5, ge=1, le=100)) -> dict[str, object]:
    """Recent headlines for a ticker plus an LLM sentiment read on them."""
    news = news_data.fetch_recent_news(ticker, limit=limit)
    articles = news["articles"]
    news_failed = news["status"] == news_data.STATUS_ERROR

    # Don't ask the model to read headlines we never got. Without this, a news
    # outage would yield a confident-looking neutral 50 instead of an error.
    if news_failed:
        analysis = sentiment.unavailable(
            f"Sentiment analysis unavailable: news feed failed ({news['message']})."
        )
    else:
        analysis = sentiment.analyze_news_sentiment(articles)  # type: ignore[arg-type]

    return {
        "ticker": ticker.strip().upper(),
        "news_status": news["status"],
        "news_message": news["message"],
        "news_count": len(articles),  # type: ignore[arg-type]
        "sentiment_analysis": analysis,
        "articles": articles,
    }

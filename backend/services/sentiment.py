"""LLM-backed market sentiment analysis over news headlines, via Google Gemini."""

from __future__ import annotations

import json
import logging
import os

from dotenv import load_dotenv
from google import genai
from google.genai import errors, types

load_dotenv()

logger = logging.getLogger(__name__)

# Model availability was established by live probe, not by list_models(), which
# advertises models that 404 on generateContent:
#   gemini-1.5-flash         retired, 404
#   gemini-2.5-flash         404, closed to new users
#   gemini-3.8-flash         429, no quota on this key
#   gemini-flash-latest      429, no quota on this key
#   gemini-3-flash-preview   works  <- primary, full Flash tier
#   gemini-flash-lite-latest works  <- fallback, weaker reasoning but live
MODEL_CHAIN = ("gemini-3-flash-preview", "gemini-flash-lite-latest")

PLACEHOLDER_KEY = "your_gemini_key_here"
REQUEST_TIMEOUT_MS = 30_000
VALID_SENTIMENTS = ("bullish", "bearish", "neutral")
NEUTRAL_SCORE = 50

STATUS_OK = "ok"
STATUS_ERROR = "error"

# Bad credentials: trying another model cannot help, so fail fast.
AUTH_STATUS_CODES = (401, 403)
# Model missing or out of quota: a different model plausibly succeeds.
FALLBACK_STATUS_CODES = (404, 429)

PROMPT_TEMPLATE = (
    "You are a financial markets analyst. Judge the overall market sentiment "
    "conveyed by the news headlines below. Base your answer ONLY on these "
    "headlines; do not draw on any outside knowledge.\n\n"
    "Headlines:\n{headlines}\n\n"
    "Respond with a JSON object only, matching this schema exactly:\n"
    '{{"sentiment": "bullish" | "bearish" | "neutral", '
    '"score": <integer 0-100, where 100 is maximally bullish, 0 maximally bearish, '
    '50 is neutral>, '
    '"reasoning": "<1-2 sentences grounded in the supplied headlines>"}}'
)

Analysis = dict[str, object]


def _no_signal(reasoning: str) -> Analysis:
    """A genuine result over an empty input set: nothing failed, nothing to read.

    Status is "ok" because the service did its job; the caller can still see
    there were no headlines via the news payload.
    """
    return {
        "status": STATUS_OK,
        "sentiment": "neutral",
        "score": NEUTRAL_SCORE,
        "reasoning": reasoning,
    }


def unavailable(reasoning: str) -> Analysis:
    """An explicit failure to produce an analysis.

    Carries neutral values so the response shape never varies, but `status`
    tells the client these numbers are placeholders rather than a model read.
    Public because the router also needs it when the upstream news feed fails.
    """
    return {
        "status": STATUS_ERROR,
        "sentiment": "neutral",
        "score": NEUTRAL_SCORE,
        "reasoning": reasoning,
    }


def _status_code(exc: Exception) -> int | None:
    """Best-effort HTTP status from a google-genai error.

    `code` is set on error instances but is not part of the class contract, so
    this falls back to scanning the message rather than assuming it exists.
    """
    for attr in ("code", "status_code"):
        value = getattr(exc, attr, None)
        if isinstance(value, int):
            return value

    text = str(exc)
    for candidate in (401, 403, 404, 429, 500, 503):
        if str(candidate) in text:
            return candidate
    return None


def _is_auth_failure(exc: Exception, code: int | None) -> bool:
    if code in AUTH_STATUS_CODES:
        return True
    text = str(exc).lower()
    return any(s in text for s in ("api key not valid", "unauthenticated", "permission denied"))


def _should_try_next_model(exc: Exception, code: int | None) -> bool:
    if code in FALLBACK_STATUS_CODES:
        return True
    text = str(exc).lower()
    return any(
        s in text
        for s in ("not found", "no longer available", "quota", "exhausted", "not supported")
    )


def _normalize(payload: dict) -> Analysis:
    """Coerce model output into the documented schema.

    The model is prompted for this shape but not bound to it, so every field is
    validated: an out-of-range score or an unexpected sentiment label would
    otherwise reach the frontend unchecked.
    """
    sentiment = str(payload.get("sentiment", "")).strip().lower()
    if sentiment not in VALID_SENTIMENTS:
        logger.warning("Model returned unexpected sentiment %r; using neutral.", sentiment)
        sentiment = "neutral"

    try:
        score = int(round(float(payload.get("score", NEUTRAL_SCORE))))
    except (TypeError, ValueError):
        logger.warning("Model returned a non-numeric score %r; using %d.", payload.get("score"), NEUTRAL_SCORE)
        score = NEUTRAL_SCORE
    score = max(0, min(score, 100))

    reasoning = str(payload.get("reasoning") or "").strip() or "No reasoning supplied by the model."

    return {
        "status": STATUS_OK,
        "sentiment": sentiment,
        "score": score,
        "reasoning": reasoning,
    }


def _generate(client: genai.Client, model: str, prompt: str) -> object:
    """One generateContent call, returning the parsed JSON payload."""
    response = client.models.generate_content(
        model=model,
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            # temperature 0 keeps a given headline set scoring consistently,
            # which matters when the number is rendered as a gauge.
            temperature=0,
            http_options=types.HttpOptions(timeout=REQUEST_TIMEOUT_MS),
        ),
    )
    return json.loads((response.text or "").strip())


def analyze_news_sentiment(news_list: list) -> Analysis:
    """Score the aggregate sentiment of the headlines in `news_list`.

    Returns {"status": "ok", ...} when a model produced a reading, and
    {"status": "error", ...} when none could. Walks MODEL_CHAIN in order,
    advancing on a 404 or 429 so a retired or quota-capped model degrades to a
    working one. Credential errors stop the walk immediately.
    """
    if not news_list:
        return _no_signal("No news data available.")

    headlines = [
        str(item.get("title")).strip()
        for item in news_list
        if isinstance(item, dict) and item.get("title")
    ]
    if not headlines:
        return _no_signal("No news data available.")

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key or api_key == PLACEHOLDER_KEY:
        logger.warning("GEMINI_API_KEY is unset or still the placeholder value.")
        return unavailable("Sentiment analysis unavailable: GEMINI_API_KEY is not configured.")

    prompt = PROMPT_TEMPLATE.format(headlines="\n".join(f"- {h}" for h in headlines))

    try:
        client = genai.Client(api_key=api_key)
    except Exception as exc:  # client construction validates the key shape
        logger.error("Could not build the Gemini client: %s", exc)
        return unavailable("Sentiment analysis unavailable: Gemini client could not be initialised.")

    last_detail = "no models attempted"

    for index, model in enumerate(MODEL_CHAIN):
        is_last = index == len(MODEL_CHAIN) - 1

        try:
            payload = _generate(client, model, prompt)

        except errors.APIError as exc:
            code = _status_code(exc)

            if _is_auth_failure(exc, code):
                logger.error("Gemini rejected the credentials (HTTP %s): %s", code, exc)
                return unavailable(
                    f"Sentiment analysis unavailable: Gemini authentication failed (HTTP {code})."
                )

            retryable = _should_try_next_model(exc, code) or isinstance(exc, errors.ServerError)
            last_detail = f"{model} failed with HTTP {code}"

            if retryable and not is_last:
                logger.warning(
                    "Model %r unavailable (HTTP %s); falling back to %r.",
                    model,
                    code,
                    MODEL_CHAIN[index + 1],
                )
                continue

            logger.error("Gemini call failed on %r (HTTP %s): %s", model, code, exc)
            return unavailable(f"Sentiment analysis unavailable: Gemini error (HTTP {code}).")

        except json.JSONDecodeError as exc:
            last_detail = f"{model} returned malformed JSON"
            logger.warning("Gemini returned malformed JSON from %r: %s", model, exc)
            if not is_last:
                continue
            return unavailable("Sentiment analysis unavailable: malformed model response.")

        except (TypeError, ValueError, AttributeError, IndexError) as exc:
            # `response.text` raises if the candidate was blocked by a safety filter.
            last_detail = f"{model} returned an unexpected response"
            logger.warning("Unexpected Gemini response from %r (%s): %s", model, type(exc).__name__, exc)
            if not is_last:
                continue
            return unavailable("Sentiment analysis unavailable: unexpected model response.")

        if not isinstance(payload, dict):
            logger.warning("Model %r returned a non-object JSON payload: %r", model, payload)
            if not is_last:
                continue
            return unavailable("Sentiment analysis unavailable: malformed model response.")

        if index > 0:
            logger.info("Sentiment produced by fallback model %r.", model)

        return _normalize(payload)

    return unavailable(f"Sentiment analysis unavailable: all models failed ({last_detail}).")


if __name__ == "__main__":
    import sys
    from pathlib import Path

    # Support `python services/sentiment.py` alongside `python -m services.sentiment`:
    # direct invocation puts services/ on sys.path, not the backend/ root.
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

    from services import news_data

    logging.basicConfig(level=logging.INFO)

    SYMBOL = "AAPL"
    news = news_data.fetch_recent_news(SYMBOL)
    print(json.dumps(analyze_news_sentiment(news["articles"]), indent=2))

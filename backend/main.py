"""FastAPI entry point for the Real-time Market Sentiment & Trading Dashboard."""

import logging
import os

from dotenv import load_dotenv

# Must run before the imports below, so any module reading configuration at
# import time already sees the .env values. Hence the E402 suppressions.
load_dotenv()

from fastapi import FastAPI  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

from routers.market import router as market_router  # noqa: E402

logger = logging.getLogger(__name__)

# Wildcard origin. Verified against Starlette 1.8: with allow_credentials=True
# this does NOT emit a literal "Access-Control-Allow-Origin: *" (which every
# browser rejects on a credentialed request). Starlette echoes the requesting
# origin instead, so the combination is legal. The trade is that it echoes
# *any* origin, so the API is callable from anywhere - acceptable while it
# serves only public market data and holds no user session, but it should be
# narrowed to the real domain via FRONTEND_URL once that domain is stable.
ALLOW_ANY_ORIGIN = "*"


def _allowed_origins() -> list[str]:
    """CORS allow-list from FRONTEND_URL, falling back to "any origin".

    Accepts a comma-separated list so one deployment can serve a production
    domain alongside Vercel preview URLs. A single value behaves as a single
    origin. Trailing slashes are trimmed because browsers send an Origin
    header without one, and "https://x.vercel.app/" would never match.

    An unset or empty FRONTEND_URL yields ["*"]. That is deliberate for the
    MVP: a CORS misconfiguration fails in the browser console with no
    server-side trace, which is a miserable thing to debug on a fresh deploy.
    Naming the origin explicitly is still the right end state; see the
    ALLOW_ANY_ORIGIN note above.
    """
    raw = os.getenv("FRONTEND_URL", "")
    origins = [origin.strip().rstrip("/") for origin in raw.split(",")]
    return [origin for origin in origins if origin] or [ALLOW_ANY_ORIGIN]


app = FastAPI(
    title="Fintech Dashboard API",
    description="Real-time market sentiment & trading dashboard backend",
    version="0.1.0",
)

_origins = _allowed_origins()

# Logged at startup so a deployed instance says which mode it is in. A CORS
# rejection is otherwise invisible server-side - it only shows up in the
# browser console - so this is the one line that makes it diagnosable from
# the Render logs.
if _origins == [ALLOW_ANY_ORIGIN]:
    logger.warning(
        "FRONTEND_URL is unset: allowing requests from any origin. "
        "Set FRONTEND_URL to your deployed frontend domain to restrict this."
    )
else:
    logger.info("CORS allow-list: %s", ", ".join(_origins))

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(market_router, prefix="/api")


@app.get("/")
async def health_check() -> dict[str, str]:
    """Liveness probe for the API."""
    return {"status": "healthy", "service": "fintech-dashboard-api"}

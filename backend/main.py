"""FastAPI entry point for the Real-time Market Sentiment & Trading Dashboard."""

import os

from dotenv import load_dotenv

# Must run before the imports below, so any module reading configuration at
# import time already sees the .env values. Hence the E402 suppressions.
load_dotenv()

from fastapi import FastAPI  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

from routers.market import router as market_router  # noqa: E402

DEFAULT_FRONTEND_URL = "http://localhost:3000"


def _allowed_origins() -> list[str]:
    """CORS allow-list from FRONTEND_URL, defaulting to local dev.

    Accepts a comma-separated list so one deployment can serve a production
    domain and Vercel preview URLs. A single value behaves as a single origin.

    Note: `allow_credentials=True` below means "*" is not a usable value here.
    Browsers reject a wildcard origin on credentialed requests, so each origin
    must be named explicitly.
    """
    raw = os.getenv("FRONTEND_URL", DEFAULT_FRONTEND_URL)
    origins = [origin.strip().rstrip("/") for origin in raw.split(",")]
    return [origin for origin in origins if origin] or [DEFAULT_FRONTEND_URL]


app = FastAPI(
    title="Fintech Dashboard API",
    description="Real-time market sentiment & trading dashboard backend",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(market_router, prefix="/api")


@app.get("/")
async def health_check() -> dict[str, str]:
    """Liveness probe for the API."""
    return {"status": "healthy", "service": "fintech-dashboard-api"}

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BrainCircuit,
  ExternalLink,
  Loader2,
  Minus,
  Newspaper,
  Search,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

type Sentiment = "bullish" | "bearish" | "neutral";

/** Explicit upstream status from the API. Replaces the previous approach of
 *  prefix-matching the `reasoning` string to guess whether the model failed. */
type UpstreamStatus = "ok" | "error";

type Article = {
  title: string | null;
  source: string | null;
  publishedAt: string | null;
  url: string | null;
};

type AssetData = {
  ticker: string;
  close: number;
};

type SentimentAnalysis = {
  status: UpstreamStatus;
  sentiment: Sentiment;
  score: number;
  reasoning: string;
};

type AnalysisData = {
  ticker: string;
  news_status: UpstreamStatus;
  news_message: string | null;
  news_count: number;
  sentiment_analysis: SentimentAnalysis;
  articles: Article[];
};

/** Static class maps. Tailwind extracts class names at build time, so these
 *  cannot be built by interpolating the sentiment into a template string. */
const SENTIMENT_THEME: Record<
  Sentiment,
  { label: string; text: string; bg: string; border: string; bar: string }
> = {
  bullish: {
    label: "Bullish",
    text: "text-emerald-400",
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/30",
    bar: "bg-emerald-500",
  },
  bearish: {
    label: "Bearish",
    text: "text-red-400",
    bg: "bg-red-500/10",
    border: "border-red-500/30",
    bar: "bg-red-500",
  },
  neutral: {
    label: "Neutral",
    text: "text-slate-300",
    bg: "bg-slate-500/10",
    border: "border-slate-600/40",
    bar: "bg-slate-500",
  },
};

function SentimentIcon({ sentiment }: { sentiment: Sentiment }) {
  const Icon =
    sentiment === "bullish"
      ? TrendingUp
      : sentiment === "bearish"
        ? TrendingDown
        : Minus;
  return <Icon className="h-5 w-5" aria-hidden="true" />;
}

function formatPrice(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDate(value: string | null) {
  if (!value) return "Unknown date";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function readDetail(response: Response): Promise<string | null> {
  try {
    const body = await response.json();
    return typeof body?.detail === "string" ? body.detail : null;
  } catch {
    return null;
  }
}

const INITIAL_TICKER = "AAPL";

type LoadResult = {
  asset: AssetData | null;
  analysis: AnalysisData | null;
  error: string | null;
};

/** Pure fetcher: performs no state updates. Keeping the network work out of the
 *  component lets the mount effect apply results only after awaiting, which
 *  avoids the cascading renders that synchronous setState in an effect causes. */
async function fetchTicker(symbol: string): Promise<LoadResult> {
  try {
    // Both endpoints hit slow upstreams, so fire them together rather than
    // serially: total latency becomes the slower of the two.
    const [assetRes, analysisRes] = await Promise.all([
      fetch(`${API_BASE}/api/asset/${encodeURIComponent(symbol)}`),
      fetch(`${API_BASE}/api/analysis/${encodeURIComponent(symbol)}`),
    ]);

    const result: LoadResult = { asset: null, analysis: null, error: null };

    // Handled independently: an unknown ticker 404s on price while news may
    // still return results, and partial data beats an empty screen.
    if (assetRes.ok) {
      result.asset = (await assetRes.json()) as AssetData;
    } else {
      result.error =
        (await readDetail(assetRes)) ?? `No price data found for ${symbol}.`;
    }

    if (analysisRes.ok) {
      result.analysis = (await analysisRes.json()) as AnalysisData;
    } else {
      result.error = result.error ?? `Could not load sentiment for ${symbol}.`;
    }

    return result;
  } catch {
    return {
      asset: null,
      analysis: null,
      error: `Cannot reach the API at ${API_BASE}. Is the FastAPI server running on port 8000?`,
    };
  }
}

export default function DashboardPage() {
  const [ticker, setTicker] = useState(INITIAL_TICKER);
  const [assetData, setAssetData] = useState<AssetData | null>(null);
  const [analysisData, setAnalysisData] = useState<AnalysisData | null>(null);
  // Starts true: the mount effect fetches immediately, so the first paint
  // should already show the loading state.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Event-handler path. setState here is synchronous by design, not in an effect.
  const load = useCallback(async (symbol: string) => {
    const clean = symbol.trim().toUpperCase();
    if (!clean) {
      setError("Enter a ticker symbol to search.");
      return;
    }

    setLoading(true);
    setError(null);

    const result = await fetchTicker(clean);
    setAssetData(result.asset);
    setAnalysisData(result.analysis);
    setError(result.error);
    setLoading(false);
  }, []);

  useEffect(() => {
    // `cancelled` keeps a slow response from writing state after unmount.
    let cancelled = false;

    void (async () => {
      const result = await fetchTicker(INITIAL_TICKER);
      if (cancelled) return;
      setAssetData(result.asset);
      setAnalysisData(result.analysis);
      setError(result.error);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const analysis = analysisData?.sentiment_analysis;
  const sentiment: Sentiment = analysis?.sentiment ?? "neutral";
  const articles = analysisData?.articles ?? [];

  // Read straight off the API contract rather than inferring from prose.
  const modelFailed = analysis?.status === "error";
  const newsFailed = analysisData?.news_status === "error";

  // A failed model has no opinion, so don't paint the card green or red on the
  // placeholder neutral it returns.
  const theme = SENTIMENT_THEME[modelFailed ? "neutral" : sentiment];

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400">
              <Activity className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">
                Market Sentiment Dashboard
              </h1>
              <p className="text-xs text-slate-400">
                Live prices and LLM-scored news sentiment
              </p>
            </div>
          </div>

          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void load(ticker);
            }}
          >
            <label htmlFor="ticker" className="sr-only">
              Ticker symbol
            </label>
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
                aria-hidden="true"
              />
              <input
                id="ticker"
                name="ticker"
                value={ticker}
                onChange={(event) => setTicker(event.target.value)}
                placeholder="AAPL"
                autoComplete="off"
                spellCheck={false}
                className="w-44 rounded-lg border border-slate-700 bg-slate-900 py-2 pl-9 pr-3 text-sm uppercase placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Search className="h-4 w-4" aria-hidden="true" />
              )}
              {loading ? "Loading" : "Analyze"}
            </button>
          </form>
        </div>
      </header>

      <div className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <div aria-live="polite" className="sr-only">
          {loading ? "Loading market data" : ""}
        </div>

        {error && (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
          >
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0"
              aria-hidden="true"
            />
            <p>{error}</p>
          </div>
        )}

        <section className="grid gap-4 sm:grid-cols-2" aria-label="Key metrics">
          <article className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
            <h2 className="text-xs font-medium uppercase tracking-wider text-slate-400">
              Last Close
            </h2>
            <p className="mt-3 text-4xl font-semibold tabular-nums">
              {assetData ? formatPrice(assetData.close) : "--"}
            </p>
            <p className="mt-2 text-sm text-slate-400">
              {assetData ? assetData.ticker : "No price loaded"}
            </p>
          </article>

          <article
            className={`rounded-2xl border p-6 ${theme.border} ${theme.bg}`}
          >
            <h2 className="text-xs font-medium uppercase tracking-wider text-slate-400">
              AI Sentiment Score
            </h2>
            <div className="mt-3 flex items-baseline gap-3">
              <p className={`text-4xl font-semibold tabular-nums ${theme.text}`}>
                {analysis && !modelFailed ? analysis.score : "--"}
              </p>
              <span className="text-sm text-slate-400">/ 100</span>
              {analysis && !modelFailed && (
                <span
                  className={`ml-auto inline-flex items-center gap-1.5 text-sm font-medium ${theme.text}`}
                >
                  <SentimentIcon sentiment={sentiment} />
                  {theme.label}
                </span>
              )}
              {modelFailed && (
                <span className="ml-auto inline-flex items-center gap-1.5 text-sm font-medium text-amber-300">
                  <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                  No reading
                </span>
              )}
            </div>
            <div
              className="mt-4 h-2 w-full overflow-hidden rounded-full bg-slate-800"
              role="progressbar"
              aria-valuenow={modelFailed ? 0 : (analysis?.score ?? 0)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Sentiment score, 0 is bearish and 100 is bullish"
            >
              <div
                className={`h-full rounded-full transition-all ${theme.bar}`}
                style={{
                  width: modelFailed ? "0%" : `${analysis?.score ?? 0}%`,
                }}
              />
            </div>
          </article>
        </section>

        <section
          className="rounded-2xl border border-slate-800 bg-gradient-to-br from-slate-900 to-slate-900/40 p-6"
          aria-label="AI reasoning"
        >
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-300">
              <BrainCircuit className="h-5 w-5" aria-hidden="true" />
            </span>
            <h2 className="text-sm font-semibold tracking-tight">
              AI Reasoning
            </h2>
            {modelFailed && (
              <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-200">
                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                Model unavailable
              </span>
            )}
          </div>
          <p
            className={`mt-4 text-base leading-relaxed ${
              modelFailed ? "text-amber-200/80" : "text-slate-200"
            }`}
          >
            {analysis?.reasoning ??
              "Run an analysis to see how the model reads the headlines."}
          </p>
        </section>

        <section aria-label="News feed">
          <div className="flex items-center gap-2">
            <Newspaper className="h-4 w-4 text-slate-400" aria-hidden="true" />
            <h2 className="text-sm font-semibold tracking-tight">
              News Feed
              {analysisData && !newsFailed ? (
                <span className="ml-2 font-normal text-slate-400">
                  {analysisData.news_count} article
                  {analysisData.news_count === 1 ? "" : "s"}
                </span>
              ) : null}
            </h2>
            {newsFailed && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-200">
                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                Unavailable
              </span>
            )}
          </div>

          {/* Three distinct empty states. The old UI collapsed the first two
              into one hedging message because the API could not tell them
              apart; news_status now settles it. */}
          {newsFailed ? (
            <div
              role="alert"
              className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-6"
            >
              <p className="flex items-center gap-2 text-sm font-medium text-amber-200">
                <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                News Feed Unavailable
              </p>
              <p className="mt-2 text-sm text-amber-200/80">
                {analysisData?.news_message ??
                  "The upstream news provider could not be reached."}
              </p>
            </div>
          ) : articles.length === 0 ? (
            <p className="mt-4 rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-6 text-sm text-slate-400">
              {analysisData
                ? `No recent English-language coverage found for ${analysisData.ticker}. The news provider responded normally.`
                : "Search a ticker to load headlines."}
            </p>
          ) : (
            <ul className="mt-4 grid gap-3 md:grid-cols-2">
              {articles.map((article, index) => (
                <li
                  key={article.url ?? `${article.title}-${index}`}
                  className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 transition hover:border-slate-700"
                >
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <span className="font-medium text-slate-300">
                      {article.source ?? "Unknown source"}
                    </span>
                    <span aria-hidden="true">·</span>
                    <time dateTime={article.publishedAt ?? undefined}>
                      {formatDate(article.publishedAt)}
                    </time>
                  </div>
                  {article.url ? (
                    <a
                      href={article.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group mt-2 inline-flex items-start gap-1.5 text-sm font-medium text-slate-100 hover:text-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                    >
                      <span>{article.title ?? "Untitled article"}</span>
                      <ExternalLink
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500 group-hover:text-emerald-400"
                        aria-hidden="true"
                      />
                      <span className="sr-only">(opens in a new tab)</span>
                    </a>
                  ) : (
                    <p className="mt-2 text-sm font-medium text-slate-100">
                      {article.title ?? "Untitled article"}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

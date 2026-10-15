"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Activity,
  AlertTriangle,
  BrainCircuit,
  Building2,
  ExternalLink,
  Loader2,
  Minus,
  Newspaper,
  Search,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

const INITIAL_TICKER = "AAPL";
const SEARCH_DEBOUNCE_MS = 220;
const MIN_QUERY_LENGTH = 1;

/* ------------------------------------------------------------------ types */

type Sentiment = "bullish" | "bearish" | "neutral";

/** Explicit upstream status from the API, rather than parsing prose. */
type UpstreamStatus = "ok" | "error";

/** Chart ranges, mirroring `SUPPORTED_PERIODS` in the backend service. */
const TIME_RANGES = ["1D", "1W", "1M", "3M", "1Y", "5Y", "MAX"] as const;
type TimeRange = (typeof TIME_RANGES)[number];
const DEFAULT_RANGE: TimeRange = "1M";

const CHART_TYPES = [
  { id: "area", label: "Area" },
  { id: "line", label: "Line" },
  { id: "candle", label: "Candle" },
  { id: "ohlc", label: "OHLC" },
] as const;
type ChartType = (typeof CHART_TYPES)[number]["id"];

/** Renderings that plot the full bar rather than just the close. */
const OHLC_CHART_TYPES = new Set<ChartType>(["candle", "ohlc"]);

type TickerMatch = {
  symbol: string;
  shortname: string | null;
  exchange: string | null;
};

type SearchResponse = {
  query: string;
  count: number;
  results: TickerMatch[];
};

type HistoryPoint = {
  /** Full ISO-8601 timestamp carrying the *exchange's* UTC offset. */
  date: string;
  /** Close gates the bar, so the other legs are individually nullable. */
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number;
};

type AssetProfile = {
  symbol: string;
  name: string;
  exchange: string | null;
  currency: string | null;
  /** IANA zone of the listing exchange, e.g. "Asia/Hong_Kong". */
  timezone: string | null;
  current_price: number | null;
  change_percent: number | null;
  volume: number | null;
  prev_close: number | null;
  /* Valuation and range metrics. All nullable: the API reports an absent
     metric as null rather than a placeholder string, which keeps these
     numeric and leaves "how missing looks" to this layer. Crypto, indexes and
     funds legitimately have no P/E, EPS or dividend. */
  market_cap: number | null;
  pe_ratio: number | null;
  eps: number | null;
  day_low: number | null;
  day_high: number | null;
  fifty_two_week_low: number | null;
  fifty_two_week_high: number | null;
  /** Already a percentage from the API: 0.32 means 0.32%, not 32%. */
  dividend_yield: number | null;
  average_volume: number | null;
};

type AssetData = {
  ticker: string;
  status: UpstreamStatus;
  period: TimeRange;
  interval: string;
  /** True for ranges whose bars are intraday, so labels want a clock time. */
  intraday: boolean;
  profile: AssetProfile;
  history: HistoryPoint[];
};

type Article = {
  title: string | null;
  source: string | null;
  publishedAt: string | null;
  url: string | null;
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
  /** Company the symbol resolved to. Non-US tickers are searched by name, so
   *  this is what was actually queried - worth showing, because it's the
   *  difference between "no coverage" and "we searched the wrong thing". */
  company: string | null;
  news_query: string | null;
  news_count: number;
  sentiment_analysis: SentimentAnalysis;
  articles: Article[];
};

/**
 * A row from /api/history: one per ticker, newest first.
 *
 * Optimistic rows use this same shape with `created_at: null`. The field is
 * nullable precisely so a not-yet-persisted entry can admit it has no server
 * timestamp, rather than inventing one from the browser clock that would
 * disagree with the row Supabase eventually writes.
 */
type RecentSearch = {
  ticker: string;
  company_name: string | null;
  created_at: string | null;
};

type HistoryResponse = {
  status: string;
  /** False when Supabase is unconfigured, which is why an empty `history`
   *  needs this to be interpretable at all. */
  persistence: boolean;
  count: number;
  history: RecentSearch[];
};

/* Each fetched slice is tagged with the key it was requested for. Comparing
   that key to the current selection is what makes the loading flags derived
   state, and it drops stale responses for free: a reply for the previous
   ticker or range simply doesn't match, so it never renders. */
type SearchSlice = { term: string; results: TickerMatch[] };
type AssetSlice = { key: string; data: AssetData | null; error: string | null };
type AnalysisSlice = { key: string; data: AnalysisData | null };

/* ----------------------------------------------------------------- theme */

/** Static class maps. Tailwind extracts class names at build time, so these
 *  cannot be built by interpolating a value into a template string. */
const SENTIMENT_THEME: Record<
  Sentiment,
  { label: string; text: string; bg: string; border: string; bar: string }
> = {
  bullish: {
    label: "Bullish",
    text: "text-emerald-600 dark:text-emerald-400",
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/30",
    bar: "bg-emerald-500",
  },
  bearish: {
    label: "Bearish",
    text: "text-red-600 dark:text-red-400",
    bg: "bg-red-500/10",
    border: "border-red-500/30",
    bar: "bg-red-500",
  },
  neutral: {
    label: "Neutral",
    text: "text-slate-600 dark:text-slate-300",
    bg: "bg-slate-500/10",
    border: "border-slate-300 dark:border-slate-700",
    bar: "bg-slate-400",
  },
};

/** Chart stroke colors. Recharts takes these as SVG props, not classes. */
const TREND_UP = "#10b981"; // emerald-500
const TREND_DOWN = "#ef4444"; // red-500
const TREND_FLAT = "#64748b"; // slate-500

const CARD =
  "rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/60";

/** Shared empty array so the "no history yet" case keeps a stable identity
 *  and doesn't invalidate the chart's memoised domain on every render. */
const NO_HISTORY: HistoryPoint[] = [];

/** One placeholder for every absent metric. The API sends null; this is the
 *  single place that decides what null looks like. */
const MISSING = "N/A";

/** Chips shown in the recent-searches row, matching the API's default page. */
const MAX_RECENT_CHIPS = 5;

/* Segmented control, shared by the range and chart-type toggles so they read
   as one control family rather than two near-miss styles. */
const SEGMENTED =
  "inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5 dark:border-slate-700 dark:bg-slate-800/60";
const SEGMENT =
  "rounded-md px-2.5 py-1 text-xs font-semibold tabular-nums transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50";
const SEGMENT_ON =
  "bg-white text-emerald-600 shadow-sm dark:bg-slate-950 dark:text-emerald-400";
const SEGMENT_OFF =
  "text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100";

/* ------------------------------------------------------------ formatting */

/**
 * Axis/tooltip formatters for the selected range.
 *
 * Everything that drives the format comes from the API, not from guesswork:
 *
 * 1. Tick granularity follows the *range*, because that's what the reader is
 *    scanning. Span grows, precision drops:
 *      1D/1W         -> "09:30"      (intraday bars)
 *      1M/3M         -> "09/15"
 *      1Y/5Y/MAX     -> "Oct 2025"
 *
 *    Month-and-year rather than a bare year on the long ranges, because the
 *    axis picks tick positions by pixel spacing, not by calendar boundaries.
 *    Two ticks inside one year both formatted to "2024", so the axis printed
 *    "2024  2024" - the labels were duplicates even though the underlying
 *    timestamps differed. Keeping the month makes every tick distinct: on 5Y
 *    adjacent ticks land about a quarter apart, on MAX about a year.
 * 2. Tooltip granularity follows the *bar interval* instead, so hover never
 *    implies precision the bar doesn't have: a 1mo bar reads "Oct 2021", not
 *    "Oct 1, 2021" as though it were a single session.
 * 3. `timeZone` is the exchange's IANA zone. Formatting in market time is the
 *    difference between a Hong Kong session reading 09:30-16:00 and the same
 *    bars sliding to 21:30-04:00 for a viewer in New York.
 *
 * Instances are built once per range and reused: MAX hands the axis 500+
 * points, and constructing an `Intl.DateTimeFormat` per tick is the kind of
 * thing that makes a chart feel sluggish for no reason.
 */
function makeAxisFormatters(
  range: TimeRange,
  intraday: boolean,
  interval: string,
  timeZone: string | null,
) {
  // `timeZone: undefined` lets Intl fall back to the viewer's zone, which is
  // the best available guess when the API couldn't tell us the exchange's.
  const base = { timeZone: timeZone ?? undefined } as const;

  const longRange = range === "1Y" || range === "5Y" || range === "MAX";

  const tickOptions: Intl.DateTimeFormatOptions = intraday
    ? { ...base, hour: "2-digit", minute: "2-digit", hour12: false }
    : longRange
      ? { ...base, month: "short", year: "numeric" }
      : { ...base, month: "2-digit", day: "2-digit" };

  // Hover deserves more context than the axis: an unlabeled "09:35" is
  // ambiguous once five sessions share the screen.
  const tooltipOptions: Intl.DateTimeFormatOptions = intraday
    ? {
        ...base,
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }
    : interval === "1mo"
      ? { ...base, month: "short", year: "numeric" }
      : { ...base, month: "short", day: "numeric", year: "numeric" };

  const safe = (options: Intl.DateTimeFormatOptions) => {
    const formatter = new Intl.DateTimeFormat("en-US", options);
    return (value: string) => {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? value : formatter.format(parsed);
    };
  };

  return { formatTick: safe(tickOptions), formatTooltip: safe(tooltipOptions) };
}

function formatCurrency(value: number | null, currency: string | null) {
  if (value === null || !Number.isFinite(value)) return MISSING;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency ?? "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    // An unrecognised ISO code would otherwise throw and blank the header.
    return `${value.toFixed(2)}${currency ? ` ${currency}` : ""}`;
  }
}

/** Axis labels need to be short, so 49,893,047 becomes "49.89M". */
function formatCompact(value: number | null) {
  if (value === null || !Number.isFinite(value)) return MISSING;
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * Market cap as "$5T" / "HK$3.76T", via `notation: "compact"` on a currency
 * format. One formatter handles every magnitude, so a 5e12 megacap and a 9e5
 * microcap both stay short without hand-rolled divisor thresholds, and the
 * scale suffix is localised rather than hardcoded to T/B/M.
 *
 * The currency style matters for correctness, not polish: Tencent's 3.76T is
 * HKD, and rendering it as "$3.76T" overstates the company by ~8x.
 */
function formatMarketCap(value: number | null, currency: string | null) {
  if (value === null || !Number.isFinite(value)) return MISSING;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency ?? "USD",
      notation: "compact",
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return formatCompact(value);
  }
}

function formatNumber(value: number | null, digits = 2) {
  if (value === null || !Number.isFinite(value)) return MISSING;
  return value.toFixed(digits);
}

/** Signed, for day change. "+0.50%" reads as a direction, not a magnitude. */
function formatPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) return MISSING;
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

/** Unsigned: a dividend yield has no direction, so no leading "+". */
function formatYield(value: number | null) {
  if (value === null || !Number.isFinite(value)) return MISSING;
  return `${value.toFixed(2)}%`;
}

/** Low-high pairs share the header's currency, so the symbol is dropped to
 *  keep the cell scannable. An en dash, not a hyphen, for a numeric range. */
function formatRange(low: number | null, high: number | null) {
  if (low === null && high === null) return MISSING;
  return `${formatNumber(low)} – ${formatNumber(high)}`;
}

function formatArticleDate(value: string | null) {
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

/** Distinguishes "the user moved on" from "the request actually failed". */
function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * Merge two recency-ordered lists of searches into one, newest first.
 *
 * `primary` wins on both position and presence, so this does double duty:
 *
 *   mergeRecent([justSelected], current)  -> optimistic prepend
 *   mergeRecent(current, fromServer)      -> reconcile without losing it
 *
 * The second call is what makes the optimistic update actually hold. The
 * history refetch fires as soon as an asset loads, but `log_search` runs as a
 * background task after the response flushes, so the server list often does
 * not contain the ticker yet. Replacing state with that response would make
 * the chip appear and then vanish - visibly worse than the lag it replaced.
 * Merging keeps local entries and lets the server fill the tail.
 *
 * De-duplication is by ticker. A repeat keeps its newer position, but will
 * backfill a `company_name` the newer entry lacked, so clicking a chip whose
 * name was never resolved doesn't discard a name the server already knew.
 */
function mergeRecent(
  primary: RecentSearch[],
  secondary: RecentSearch[],
  limit = MAX_RECENT_CHIPS,
): RecentSearch[] {
  const byTicker = new Map<string, RecentSearch>();

  for (const row of [...primary, ...secondary]) {
    const ticker = (row?.ticker ?? "").trim().toUpperCase();
    if (!ticker) continue;

    const existing = byTicker.get(ticker);
    if (existing) {
      if (!existing.company_name && row.company_name) {
        byTicker.set(ticker, { ...existing, company_name: row.company_name });
      }
      continue;
    }

    byTicker.set(ticker, {
      ticker,
      company_name: row.company_name ?? null,
      created_at: row.created_at ?? null,
    });
  }

  return [...byTicker.values()].slice(0, limit);
}

/* ------------------------------------------------------------------ hooks */

/**
 * Trailing-edge debounce.
 *
 * Each render with a new `value` schedules an update and the cleanup cancels
 * the one already pending, so a fast typist only ever leaves one timer alive
 * and the value settles `delay` ms after the final keystroke.
 */
function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

/* ----------------------------------------------------------- subcomponents */

function SentimentIcon({ sentiment }: { sentiment: Sentiment }) {
  const Icon =
    sentiment === "bullish"
      ? TrendingUp
      : sentiment === "bearish"
        ? TrendingDown
        : Minus;
  return <Icon className="h-5 w-5" aria-hidden="true" />;
}

/** One cell of the metrics grid: label above value, hairline separator. */
function StatCell({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  const muted = value === MISSING;
  return (
    <div className="border-b border-slate-100 py-2.5 dark:border-slate-800/80">
      <dt className="text-[11px] font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}
      </dt>
      <dd
        className={`mt-1 text-sm font-semibold tabular-nums ${
          accent ??
          (muted
            ? "text-slate-400 dark:text-slate-600"
            : "text-slate-900 dark:text-slate-100")
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

/* ------------------------------------------------------- candle geometry */

/**
 * Props recharts hands a custom `Bar` shape.
 *
 * Verified against `recharts/lib/cartesian/Bar.js`: each rect item is the data
 * entry spread together with `{x, y, width, height, value, payload,
 * background}`, so `payload` is the original `HistoryPoint`.
 */
type BarShapeProps = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: HistoryPoint;
};

/** Close is the only guaranteed leg, so the others collapse onto it rather
 *  than rendering NaN geometry. */
function normalizeBar(point: HistoryPoint) {
  const close = point.close;
  const open = point.open ?? close;
  return {
    open,
    close,
    high: point.high ?? Math.max(open, close),
    low: point.low ?? Math.min(open, close),
  };
}

/**
 * Price -> y pixel, using only the bar's own box.
 *
 * The `Bar` below is fed `dataKey={[low, high]}`, and recharts maps an array
 * value to `y = scale(high)` and `height = scale(low) - scale(high)`. So the
 * rect it hands us already spans exactly the wick: `y` is the high, `y +
 * height` is the low. That makes every other price a linear interpolation
 * inside that box:
 *
 *     toY(p) = y + (high - p) / (high - low) * height
 *
 * Note what this avoids: the shape never touches the y-axis scale, the plot
 * offset, or the axis base. It can't drift out of sync with the axis because
 * it derives everything from the box recharts computed from that same axis.
 * Check the ends - toY(high) = y, toY(low) = y + height.
 *
 * A zero range (an untraded bar where high == low) would divide by zero, so it
 * degenerates to the single line at `y`.
 */
function makePriceScale(top: number, span: number, high: number, low: number) {
  const range = high - low;
  if (!(range > 0)) return () => top;
  return (price: number) => top + ((high - price) / range) * span;
}

/** Up/down coloring, shared by both bar renderings. A flat bar counts as up,
 *  matching the convention that unchanged is not a decline. */
function barColor(open: number, close: number) {
  return close >= open ? TREND_UP : TREND_DOWN;
}

/**
 * Candlestick: wick from low to high, body from open to close.
 *
 * The body is floored at 1px so a doji (open == close) stays visible as a
 * line instead of vanishing into a zero-height rect, and the body width is
 * floored likewise so MAX's 500 bars still render something at ~2px a band.
 */
function Candlestick({ x, y, width, height, payload }: BarShapeProps) {
  if (x == null || y == null || width == null || height == null || !payload) {
    return null;
  }

  const { open, high, low, close } = normalizeBar(payload);
  const toY = makePriceScale(y, height, high, low);
  const color = barColor(open, close);

  const center = x + width / 2;
  const bodyWidth = Math.max(1, width * 0.7);
  const yOpen = toY(open);
  const yClose = toY(close);

  return (
    <g>
      <line
        x1={center}
        x2={center}
        y1={y}
        y2={y + height}
        stroke={color}
        strokeWidth={1}
      />
      <rect
        x={center - bodyWidth / 2}
        y={Math.min(yOpen, yClose)}
        width={bodyWidth}
        height={Math.max(1, Math.abs(yClose - yOpen))}
        fill={color}
      />
    </g>
  );
}

/**
 * OHLC bar: the same low-high wick, with open ticking left and close ticking
 * right. Reads more precisely than a candle at dense ranges because the ticks
 * stay 1px regardless of how narrow the band gets.
 */
function OHLCBar({ x, y, width, height, payload }: BarShapeProps) {
  if (x == null || y == null || width == null || height == null || !payload) {
    return null;
  }

  const { open, high, low, close } = normalizeBar(payload);
  const toY = makePriceScale(y, height, high, low);
  const color = barColor(open, close);

  const center = x + width / 2;
  // Each tick claims a little over a third of the band, leaving a visible gap
  // between neighbouring bars.
  const tick = Math.max(1, width * 0.36);
  const yOpen = toY(open);
  const yClose = toY(close);

  return (
    <g stroke={color} strokeWidth={1}>
      <line x1={center} x2={center} y1={y} y2={y + height} />
      <line x1={center - tick} x2={center} y1={yOpen} y2={yOpen} />
      <line x1={center} x2={center + tick} y1={yClose} y2={yClose} />
    </g>
  );
}

/** Picks the bar renderer for the active toggle. Returns an element so
 *  recharts clones it with the per-bar geometry, which is its documented
 *  contract for `shape`. */
function renderOhlcShape(chartType: ChartType) {
  return chartType === "candle" ? <Candlestick /> : <OHLCBar />;
}

/** Hover readout. Shows the full OHLC bar rather than just the plotted close,
 *  which is the data-density a trading view is expected to have - and it keeps
 *  the OHLC payload exercised ahead of candlesticks in Phase 2.2. */
function ChartTooltip({
  point,
  label,
  currency,
}: {
  point: HistoryPoint;
  label: string;
  currency: string | null;
}) {
  const legs: Array<[string, number | null]> = [
    ["O", point.open],
    ["H", point.high],
    ["L", point.low],
    ["C", point.close],
  ];

  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-slate-700 dark:bg-slate-900">
      <p className="font-medium text-slate-500 dark:text-slate-400">{label}</p>
      <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5">
        {legs.map(([leg, value]) => (
          <div key={leg} className="flex items-baseline gap-1.5">
            <dt className="w-3 text-slate-400 dark:text-slate-500">{leg}</dt>
            <dd className="font-semibold tabular-nums">
              {formatCurrency(value, currency)}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-1.5 border-t border-slate-100 pt-1.5 text-slate-500 dark:border-slate-800 dark:text-slate-400">
        Vol <span className="tabular-nums">{formatCompact(point.volume)}</span>
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------- page */

export default function DashboardPage() {
  // `query` is the raw input. Results are stored tagged with the term they
  // belong to, which lets "is searching" be derived rather than tracked.
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchSlice | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  // Quick-links under the search bar. Starts empty so the row is simply
  // absent until data lands, rather than reserving space for a spinner.
  const [recentSearches, setRecentSearches] = useState<RecentSearch[]>([]);

  // Selected asset. Both payloads carry the key they were fetched for, so the
  // loading flags are derived and a stale response can't paint the wrong
  // asset: its key simply no longer matches.
  const [ticker, setTicker] = useState(INITIAL_TICKER);
  const [timeRange, setTimeRange] = useState<TimeRange>(DEFAULT_RANGE);
  // Presentation only: switching rendering must not refetch, so this is
  // deliberately absent from the asset effect's dependencies.
  const [chartType, setChartType] = useState<ChartType>("area");
  const [asset, setAsset] = useState<AssetSlice | null>(null);
  const [analysisSlice, setAnalysisSlice] = useState<AnalysisSlice | null>(
    null,
  );

  const comboRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();

  /* -- derived search state ---------------------------------------------- */

  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const typed = debouncedQuery.trim();

  // Empty string means "nothing to look up", which covers both a short query
  // and an input that already reads as the loaded symbol - the state selecting
  // a result leaves behind. Without the second check, picking "AAPL" would
  // immediately search for "AAPL" and reopen the dropdown over the chart.
  const searchTerm =
    typed.length >= MIN_QUERY_LENGTH && typed !== ticker ? typed : "";
  const searchResults = search?.term === searchTerm ? search.results : [];
  const isSearching = searchTerm !== "" && search?.term !== searchTerm;
  // Clamped on read instead of reset in an effect, so a shrinking result list
  // can never leave the highlight pointing past the end.
  const activeIndex = highlighted < searchResults.length ? highlighted : -1;

  const assetKey = `${ticker}|${timeRange}`;
  const isLoadingAsset = asset?.key !== assetKey;
  const assetData = asset?.key === assetKey ? asset.data : null;
  const assetError = asset?.key === assetKey ? asset.error : null;

  const isLoadingAnalysis = analysisSlice?.key !== ticker;
  const analysisData =
    analysisSlice?.key === ticker ? analysisSlice.data : null;

  /* -- autocomplete ------------------------------------------------------ */

  useEffect(() => {
    // Bails before touching state: React's compiler lint rejects synchronous
    // setState in an effect body, and every write below lands after an await.
    if (searchTerm === "") return;

    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(
          `${API_BASE}/api/search?q=${encodeURIComponent(searchTerm)}&limit=8`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const body = (await response.json()) as SearchResponse;
        setSearch({ term: searchTerm, results: body.results });
      } catch (error) {
        if (isAbort(error)) return;
        // A dead search endpoint shouldn't interrupt the chart. Recording the
        // term with no results also clears the spinner.
        setSearch({ term: searchTerm, results: [] });
      }
    })();

    // Aborting on cleanup is what stops a slow "ap" response from landing
    // after a fast "apple" one and repopulating the list with stale matches.
    return () => controller.abort();
  }, [searchTerm]);

  // Close on outside click, the other half of dismissal alongside Escape.
  useEffect(() => {
    if (!isOpen) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!comboRef.current?.contains(event.target as Node)) setIsOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [isOpen]);

  /**
   * Load an asset, settle the search box, and show its chip immediately.
   *
   * `inputValue` is what the box should read afterwards, which is the only
   * difference between the two entry points: picking a dropdown result leaves
   * the symbol in the box as confirmation, while a recent-search chip clears
   * it. Both land on "" or the loaded ticker, and `searchTerm` treats either
   * as nothing to look up - so neither reopens the dropdown over the chart.
   *
   * The chip is added here, in the same handler that sets the ticker, so it
   * lands in the same render rather than one database round trip later.
   */
  const selectAsset = useCallback(
    (symbol: string, inputValue: string, companyName: string | null = null) => {
      const ticker = symbol.trim().toUpperCase();

      setQuery(inputValue);
      setTicker(ticker);
      setIsOpen(false);
      setHighlighted(-1);

      // Functional updater, not a read of `recentSearches`: that keeps this
      // callback stable and correct if two selections batch into one render.
      setRecentSearches((current) =>
        mergeRecent(
          [{ ticker, company_name: companyName, created_at: null }],
          current,
        ),
      );
    },
    [],
  );

  // `shortname` -> `company_name` is the key translation between the search
  // and history shapes; both ultimately carry Yahoo's shortName.
  const selectMatch = useCallback(
    (match: TickerMatch) =>
      selectAsset(match.symbol, match.symbol, match.shortname),
    [selectAsset],
  );

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setIsOpen(false);
      return;
    }
    if (!isOpen || searchResults.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted((index) => (index + 1) % searchResults.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted(
        (index) => (index <= 0 ? searchResults.length : index) - 1,
      );
    } else if (event.key === "Enter" && activeIndex >= 0) {
      event.preventDefault();
      selectMatch(searchResults[activeIndex]);
    }
  };

  /* -- asset + history --------------------------------------------------- */

  // Keyed on [ticker, timeRange]: clicking a range button refetches the chart
  // and nothing else.
  useEffect(() => {
    const controller = new AbortController();
    const key = `${ticker}|${timeRange}`;

    void (async () => {
      try {
        const response = await fetch(
          `${API_BASE}/api/asset/${encodeURIComponent(ticker)}?period=${timeRange}`,
          { signal: controller.signal },
        );

        if (!response.ok) {
          setAsset({
            key,
            data: null,
            error: (await readDetail(response)) ?? `No data found for ${ticker}.`,
          });
          return;
        }

        setAsset({
          key,
          data: (await response.json()) as AssetData,
          error: null,
        });
      } catch (error) {
        if (isAbort(error)) return;
        setAsset({
          key,
          data: null,
          error: `Cannot reach the API at ${API_BASE}. Is the FastAPI server running on port 8000?`,
        });
      }
    })();

    return () => controller.abort();
  }, [ticker, timeRange]);

  /* -- sentiment + news -------------------------------------------------- */

  // Deliberately keyed on [ticker] only. Headlines and the LLM read don't vary
  // by chart range, so switching 1D -> 5Y must not re-run a model call.
  useEffect(() => {
    const controller = new AbortController();
    const key = ticker;

    void (async () => {
      try {
        const response = await fetch(
          `${API_BASE}/api/analysis/${encodeURIComponent(ticker)}`,
          { signal: controller.signal },
        );
        setAnalysisSlice({
          key,
          data: response.ok ? ((await response.json()) as AnalysisData) : null,
        });
      } catch (error) {
        if (isAbort(error)) return;
        setAnalysisSlice({ key, data: null });
      }
    })();

    return () => controller.abort();
  }, [ticker]);

  /* -- recent searches --------------------------------------------------- */

  // Keyed on the symbol that successfully loaded, not on `assetKey`. Both
  // would refetch on mount and on every ticker change, but `assetKey` also
  // changes when only the chart range does - and flipping 1D -> 5Y adds no
  // new ticker to history, so that would be six wasted round trips.
  const loadedSymbol = assetData?.profile.symbol ?? null;

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(`${API_BASE}/api/history`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const body = (await response.json()) as HistoryResponse;
        if (body.status !== "ok" || !body.persistence) return;

        // Merged, not replaced. On mount `current` is empty so this is purely
        // the server's list; after a selection it preserves the optimistic
        // chip that the pending background write hasn't persisted yet.
        setRecentSearches((current) =>
          mergeRecent(current, body.history ?? []),
        );
      } catch (error) {
        if (isAbort(error)) return;
        // Local entries are left alone on purpose. They are the user's own
        // in-session selections, so they stay trustworthy even when the
        // history endpoint is unreachable - and on a cold load there is
        // nothing to clear anyway.
      }
    })();

    return () => controller.abort();
  }, [loadedSymbol]);

  /* -- derived presentation ---------------------------------------------- */

  const profile = assetData?.profile ?? null;
  const history = assetData?.history ?? NO_HISTORY;

  const changePercent = profile?.change_percent ?? null;
  const isUp = (changePercent ?? 0) >= 0;
  const trendColor =
    changePercent === null ? TREND_FLAT : isUp ? TREND_UP : TREND_DOWN;
  const changeClass =
    changePercent === null
      ? "text-slate-500 dark:text-slate-400"
      : isUp
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-red-600 dark:text-red-400";

  // Rebuilt only when the range, bar interval or exchange zone changes, never
  // per tick.
  const { formatTick, formatTooltip } = useMemo(
    () =>
      makeAxisFormatters(
        assetData?.period ?? timeRange,
        assetData?.intraday ?? false,
        assetData?.interval ?? "1d",
        profile?.timezone ?? null,
      ),
    [
      assetData?.period,
      assetData?.intraday,
      assetData?.interval,
      profile?.timezone,
      timeRange,
    ],
  );

  const showsOhlc = OHLC_CHART_TYPES.has(chartType);

  // Equities rarely move enough for a 0-based axis to show anything; pad the
  // real range instead so intraday detail stays visible. Candle and OHLC
  // bracket lows and highs rather than closes, otherwise wicks would be
  // clipped by an axis that only knows about closing prices.
  const yDomain = useMemo<[number, number] | undefined>(() => {
    if (history.length === 0) return undefined;

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const point of history) {
      const bar = normalizeBar(point);
      min = Math.min(min, showsOhlc ? bar.low : bar.close);
      max = Math.max(max, showsOhlc ? bar.high : bar.close);
    }

    const pad = (max - min) * 0.08 || Math.abs(max) * 0.01 || 1;
    return [min - pad, max + pad];
  }, [history, showsOhlc]);

  const analysis = analysisData?.sentiment_analysis;
  const sentiment: Sentiment = analysis?.sentiment ?? "neutral";
  const articles = analysisData?.articles ?? [];
  const modelFailed = analysis?.status === "error";
  const newsFailed = analysisData?.news_status === "error";
  // A failed model has no opinion, so don't paint the card on its placeholder.
  const theme = SENTIMENT_THEME[modelFailed ? "neutral" : sentiment];

  /* -- render ------------------------------------------------------------ */

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/80 backdrop-blur dark:border-slate-800 dark:bg-slate-950/80">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <Activity className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h1 className="text-base font-semibold tracking-tight">
                Market Sentiment Dashboard
              </h1>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Live prices, interactive charts and LLM-scored news
              </p>
            </div>
          </div>

          {/* Combobox: input + absolutely positioned listbox. */}
          <div ref={comboRef} className="relative w-full sm:w-80">
            <label htmlFor="asset-search" className="sr-only">
              Search by company name or ticker
            </label>
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
              aria-hidden="true"
            />
            <input
              id="asset-search"
              role="combobox"
              aria-expanded={isOpen}
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-activedescendant={
                activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined
              }
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                // Typing is intent to see matches. Opening here, in an event
                // handler, keeps it out of the fetch effect.
                setIsOpen(true);
                setHighlighted(-1);
              }}
              onKeyDown={onSearchKeyDown}
              onFocus={() => {
                if (searchResults.length > 0) setIsOpen(true);
              }}
              placeholder="Search Apple, AAPL, 0700.HK..."
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-9 text-sm placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 dark:border-slate-700 dark:bg-slate-900 dark:placeholder:text-slate-500"
            />
            {isSearching && (
              <Loader2
                className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-slate-400"
                aria-hidden="true"
              />
            )}

            {isOpen && searchResults.length > 0 && (
              <ul
                id={listboxId}
                role="listbox"
                aria-label="Search results"
                className="absolute left-0 right-0 top-full z-30 mt-2 max-h-80 overflow-auto rounded-xl border border-slate-200 bg-white py-1 shadow-xl dark:border-slate-700 dark:bg-slate-900"
              >
                {searchResults.map((match, index) => (
                  <li key={`${match.symbol}-${index}`}>
                    <button
                      id={`${listboxId}-${index}`}
                      role="option"
                      aria-selected={index === activeIndex}
                      type="button"
                      onMouseEnter={() => setHighlighted(index)}
                      onClick={() => selectMatch(match)}
                      className={`flex w-full items-center gap-3 px-3 py-2 text-left transition ${
                        index === activeIndex
                          ? "bg-slate-100 dark:bg-slate-800"
                          : ""
                      }`}
                    >
                      <span className="min-w-16 font-mono text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                        {match.symbol}
                      </span>
                      <span className="flex-1 truncate text-sm">
                        {match.shortname ?? "Unknown name"}
                      </span>
                      <span className="shrink-0 text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
                        {match.exchange ?? "--"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Recent searches. Full-width row rather than nested inside the
            combobox, which is only 20rem wide - five chips in there would
            wrap onto three lines and push the chart down. Right-aligned on
            desktop so the row still reads as belonging to the search box. */}
        {recentSearches.length > 0 && (
          <div
            role="group"
            aria-label="Recent searches"
            className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-6 pb-3 sm:justify-end"
          >
            <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400 dark:text-slate-500">
              Recent
            </span>
            {recentSearches.map((row) => {
              const active = row.ticker === ticker;
              return (
                <button
                  key={row.ticker}
                  type="button"
                  onClick={() => selectAsset(row.ticker, "", row.company_name)}
                  // The ticker alone is cryptic for foreign listings, so the
                  // resolved company name rides along as a tooltip.
                  title={row.company_name ?? row.ticker}
                  aria-current={active ? "true" : undefined}
                  className={`rounded-full px-2.5 py-1 font-mono text-xs font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 ${
                    active
                      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                      : "bg-slate-100 text-slate-600 hover:bg-emerald-500/10 hover:text-emerald-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-emerald-500/10 dark:hover:text-emerald-300"
                  }`}
                >
                  {row.ticker}
                </button>
              );
            })}
          </div>
        )}
      </header>

      <div className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <div aria-live="polite" className="sr-only">
          {isLoadingAsset ? `Loading ${ticker}` : ""}
        </div>

        {assetError && (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-200"
          >
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0"
              aria-hidden="true"
            />
            <p>{assetError}</p>
          </div>
        )}

        {/* KPI header */}
        <section className={`${CARD} p-6`} aria-label="Asset summary">
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-2xl font-semibold tracking-tight">
                  {profile?.name ?? ticker}
                </h2>
                {isLoadingAsset && (
                  <Loader2
                    className="h-4 w-4 shrink-0 animate-spin text-slate-400"
                    aria-hidden="true"
                  />
                )}
              </div>
              <p className="mt-1 flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                <span className="font-mono font-semibold text-slate-700 dark:text-slate-300">
                  {profile?.symbol ?? ticker}
                </span>
                <span aria-hidden="true">·</span>
                <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{profile?.exchange ?? "--"}</span>
              </p>
            </div>

            <div className="text-right">
              <p className="text-3xl font-semibold tabular-nums">
                {formatCurrency(
                  profile?.current_price ?? null,
                  profile?.currency ?? null,
                )}
              </p>
              <p
                className={`mt-1 flex items-center justify-end gap-1.5 text-sm font-semibold tabular-nums ${changeClass}`}
              >
                {changePercent !== null &&
                  (isUp ? (
                    <TrendingUp className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <TrendingDown className="h-4 w-4" aria-hidden="true" />
                  ))}
                {formatPercent(changePercent)}
              </p>
            </div>
          </div>
        </section>

        {/* Range selector + chart */}
        <section className={`${CARD} p-6`} aria-label="Price history">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold tracking-tight">
                Price History
              </h2>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                {history.length > 0
                  ? `${history.length} points · ${assetData?.interval ?? ""} bars${
                      profile?.timezone ? ` · ${profile.timezone}` : ""
                    }`
                  : "No price history loaded"}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div
                role="group"
                aria-label="Chart time range"
                className={SEGMENTED}
              >
                {TIME_RANGES.map((range) => {
                  const selected = range === timeRange;
                  return (
                    <button
                      key={range}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setTimeRange(range)}
                      className={`${SEGMENT} ${
                        selected ? SEGMENT_ON : SEGMENT_OFF
                      }`}
                    >
                      {range}
                    </button>
                  );
                })}
              </div>

              <div role="group" aria-label="Chart type" className={SEGMENTED}>
                {CHART_TYPES.map(({ id, label }) => {
                  const selected = id === chartType;
                  return (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setChartType(id)}
                      className={`${SEGMENT} ${
                        selected ? SEGMENT_ON : SEGMENT_OFF
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="mt-6 h-80 w-full">
            {history.length === 0 ? (
              <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-slate-300 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                {isLoadingAsset
                  ? "Loading chart..."
                  : `No ${timeRange} history available for ${ticker}.`}
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                {/* ComposedChart rather than swapping AreaChart/LineChart:
                    one chart means one set of axes, grid and tooltip instead
                    of two near-identical copies drifting apart, and it's the
                    container that can host candlestick shapes in Phase 2.2. */}
                <ComposedChart
                  data={history}
                  margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
                      <stop
                        offset="0%"
                        stopColor={trendColor}
                        stopOpacity={0.28}
                      />
                      <stop
                        offset="100%"
                        stopColor={trendColor}
                        stopOpacity={0}
                      />
                    </linearGradient>
                  </defs>

                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="var(--chart-grid)"
                    vertical={false}
                  />
                  {/* Category axis on purpose: a time-scaled axis would leave
                      dead gaps for nights, weekends and holidays, which is not
                      how trading platforms draw sessions. */}
                  <XAxis
                    dataKey="date"
                    tickFormatter={formatTick}
                    stroke="var(--chart-axis)"
                    tick={{ fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={28}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    domain={yDomain}
                    tickFormatter={(value: number) => formatCompact(value)}
                    stroke="var(--chart-axis)"
                    tick={{ fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    width={56}
                    orientation="right"
                  />
                  <Tooltip
                    cursor={{
                      stroke: "var(--chart-cursor)",
                      strokeDasharray: "3 3",
                    }}
                    content={({ active, payload, label }) => {
                      const point = payload?.[0]?.payload as
                        | HistoryPoint
                        | undefined;
                      if (!active || !point) return null;
                      return (
                        <ChartTooltip
                          point={point}
                          label={formatTooltip(String(label))}
                          currency={profile?.currency ?? null}
                        />
                      );
                    }}
                  />

                  {chartType === "area" && (
                    <Area
                      type="monotone"
                      dataKey="close"
                      stroke={trendColor}
                      strokeWidth={2}
                      fill="url(#priceFill)"
                      dot={false}
                      activeDot={{ r: 3, strokeWidth: 0 }}
                      isAnimationActive={false}
                    />
                  )}

                  {chartType === "line" && (
                    <Line
                      type="monotone"
                      dataKey="close"
                      stroke={trendColor}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 3, strokeWidth: 0 }}
                      isAnimationActive={false}
                    />
                  )}

                  {showsOhlc && (
                    /* The array dataKey is what makes the custom shapes work:
                       it tells recharts to span the rect from low to high, so
                       the shape can interpolate open/close inside that box
                       without ever reaching for the axis scale. */
                    <Bar
                      dataKey={(point: HistoryPoint) => [
                        point.low ?? point.close,
                        point.high ?? point.close,
                      ]}
                      shape={renderOhlcShape(chartType)}
                      activeBar={false}
                      isAnimationActive={false}
                    />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
        </section>

        {/* Key statistics */}
        <section className={`${CARD} p-6`} aria-label="Key statistics">
          <h2 className="text-sm font-semibold tracking-tight">
            Key Statistics
          </h2>
          <dl className="mt-2 grid grid-cols-2 gap-x-8 sm:grid-cols-3 lg:grid-cols-4">
            <StatCell
              label="Prev Close"
              value={formatCurrency(
                profile?.prev_close ?? null,
                profile?.currency ?? null,
              )}
            />
            <StatCell
              label="Day Range"
              value={formatRange(
                profile?.day_low ?? null,
                profile?.day_high ?? null,
              )}
            />
            <StatCell
              label="52W Range"
              value={formatRange(
                profile?.fifty_two_week_low ?? null,
                profile?.fifty_two_week_high ?? null,
              )}
            />
            {/* Volume beside its own average is the comparison that matters:
                the absolute number alone says nothing about unusual activity. */}
            <StatCell
              label="Vol / Avg Vol"
              value={`${formatCompact(profile?.volume ?? null)} / ${formatCompact(
                profile?.average_volume ?? null,
              )}`}
            />
            <StatCell
              label="Market Cap"
              value={formatMarketCap(
                profile?.market_cap ?? null,
                profile?.currency ?? null,
              )}
            />
            <StatCell
              label="P/E (TTM)"
              value={formatNumber(profile?.pe_ratio ?? null)}
            />
            <StatCell
              label="EPS (TTM)"
              value={formatCurrency(
                profile?.eps ?? null,
                profile?.currency ?? null,
              )}
            />
            <StatCell
              label="Div Yield"
              value={formatYield(profile?.dividend_yield ?? null)}
            />
          </dl>
        </section>

        {/* Sentiment */}
        <section className="grid gap-4 lg:grid-cols-3" aria-label="AI sentiment">
          <article className={`rounded-2xl border p-6 ${theme.border} ${theme.bg}`}>
            <h2 className="text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
              AI Sentiment Score
            </h2>
            <div className="mt-3 flex items-baseline gap-3">
              <p className={`text-4xl font-semibold tabular-nums ${theme.text}`}>
                {analysis && !modelFailed ? analysis.score : "--"}
              </p>
              <span className="text-sm text-slate-500 dark:text-slate-400">
                / 100
              </span>
              {analysis && !modelFailed && (
                <span
                  className={`ml-auto inline-flex items-center gap-1.5 text-sm font-medium ${theme.text}`}
                >
                  <SentimentIcon sentiment={sentiment} />
                  {theme.label}
                </span>
              )}
              {modelFailed && (
                <span className="ml-auto inline-flex items-center gap-1.5 text-sm font-medium text-amber-600 dark:text-amber-300">
                  <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                  No reading
                </span>
              )}
            </div>
            <div
              className="mt-4 h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
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

          <article className={`${CARD} p-6 lg:col-span-2`}>
            <div className="flex items-center gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-300">
                <BrainCircuit className="h-5 w-5" aria-hidden="true" />
              </span>
              <h2 className="text-sm font-semibold tracking-tight">
                AI Reasoning
              </h2>
              {isLoadingAnalysis && (
                <Loader2
                  className="h-4 w-4 animate-spin text-slate-400"
                  aria-hidden="true"
                />
              )}
              {modelFailed && (
                <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-700 dark:text-amber-200">
                  <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                  Model unavailable
                </span>
              )}
            </div>
            <p
              className={`mt-4 text-sm leading-relaxed ${
                modelFailed
                  ? "text-amber-700 dark:text-amber-200/80"
                  : "text-slate-700 dark:text-slate-200"
              }`}
            >
              {analysis?.reasoning ??
                (isLoadingAnalysis
                  ? "Reading the latest headlines..."
                  : "No sentiment reading available for this asset.")}
            </p>
          </article>
        </section>

        {/* News */}
        <section aria-label="News feed">
          <div className="flex items-center gap-2">
            <Newspaper
              className="h-4 w-4 text-slate-500 dark:text-slate-400"
              aria-hidden="true"
            />
            <h2 className="text-sm font-semibold tracking-tight">
              News Feed
              {analysisData && !newsFailed ? (
                <span className="ml-2 font-normal text-slate-500 dark:text-slate-400">
                  {analysisData.news_count} article
                  {analysisData.news_count === 1 ? "" : "s"}
                </span>
              ) : null}
            </h2>
            {analysisData?.company && (
              <span className="rounded-full border border-slate-200 px-2 py-0.5 text-[11px] text-slate-500 dark:border-slate-700 dark:text-slate-400">
                searched “{analysisData.company}”
              </span>
            )}
            {newsFailed && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-700 dark:text-amber-200">
                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                Unavailable
              </span>
            )}
          </div>

          {/* Three distinct empty states, kept apart by news_status: upstream
              failure, genuinely quiet coverage, and nothing loaded yet. */}
          {newsFailed ? (
            <div
              role="alert"
              className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-6"
            >
              <p className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-200">
                <AlertTriangle
                  className="h-4 w-4 shrink-0"
                  aria-hidden="true"
                />
                News Feed Unavailable
              </p>
              <p className="mt-2 text-sm text-amber-700/80 dark:text-amber-200/80">
                {analysisData?.news_message ??
                  "The upstream news provider could not be reached."}
              </p>
            </div>
          ) : articles.length === 0 ? (
            <p
              className={`mt-4 ${CARD} px-4 py-6 text-sm text-slate-500 dark:text-slate-400`}
            >
              {isLoadingAnalysis
                ? "Loading headlines..."
                : analysisData
                  ? `No recent English-language coverage found for ${analysisData.ticker}. The news provider responded normally.`
                  : "Search an asset to load headlines."}
            </p>
          ) : (
            <ul className="mt-4 grid gap-3 md:grid-cols-2">
              {articles.map((article, index) => (
                <li
                  key={article.url ?? `${article.title}-${index}`}
                  className={`${CARD} p-4 transition hover:border-slate-300 dark:hover:border-slate-700`}
                >
                  <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                    <span className="font-medium text-slate-700 dark:text-slate-300">
                      {article.source ?? "Unknown source"}
                    </span>
                    <span aria-hidden="true">·</span>
                    <time dateTime={article.publishedAt ?? undefined}>
                      {formatArticleDate(article.publishedAt)}
                    </time>
                  </div>
                  {article.url ? (
                    <a
                      href={article.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group mt-2 inline-flex items-start gap-1.5 text-sm font-medium hover:text-emerald-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 dark:hover:text-emerald-400"
                    >
                      <span>{article.title ?? "Untitled article"}</span>
                      <ExternalLink
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400 group-hover:text-emerald-600 dark:group-hover:text-emerald-400"
                        aria-hidden="true"
                      />
                      <span className="sr-only">(opens in a new tab)</span>
                    </a>
                  ) : (
                    <p className="mt-2 text-sm font-medium">
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

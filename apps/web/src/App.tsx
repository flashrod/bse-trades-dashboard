import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  API_BASE,
  fetchLatestPull,
  fetchStats,
  fetchTradesPage,
  startPull
} from './api';
import { formatDuration, formatIST, formatQty } from './format';
import type { ConnectionState, Progress, Pull, Stats, Trade } from './types';
import { TradeTable } from './components/TradeTable';
import { SideRail } from './components/SideRail';
import { Reveal } from './components/Reveal';
import {
  IconChevronDown,
  IconClose,
  IconPull,
  IconSearch
} from './components/Icons';

const PAGE_SIZE = 1000;
const MAX_PAGES = 20;

function statusLabel(status: string | undefined): string {
  switch (status) {
    case 'running':
      return 'In progress';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'interrupted':
      return 'Interrupted';
    default:
      return 'No runs';
  }
}

type Tone = 'neutral' | 'green' | 'yellow' | 'red' | 'blue';

const TONES: Record<Tone, string> = {
  neutral: 'bg-canvas text-muted',
  green: 'bg-pale-green text-pale-green-ink',
  yellow: 'bg-pale-yellow text-pale-yellow-ink',
  red: 'bg-pale-red text-pale-red-ink',
  blue: 'bg-pale-blue text-pale-blue-ink'
};

function statusTone(status: string | undefined): Tone {
  switch (status) {
    case 'running':
      return 'yellow';
    case 'completed':
      return 'green';
    case 'failed':
      return 'red';
    case 'interrupted':
      return 'blue';
    default:
      return 'neutral';
  }
}

function plural(count: number, singular: string): string {
  return `${formatQty(count)} ${singular}${count === 1 ? '' : 's'}`;
}

export default function App() {
  const mapRef = useRef<Map<string, Trade>>(new Map());
  const searchRef = useRef<HTMLInputElement>(null);

  const [version, setVersion] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);
  const [pull, setPull] = useState<Pull | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [newIds, setNewIds] = useState<Map<string, number>>(new Map());
  const [sessionNew, setSessionNew] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const [symbol, setSymbol] = useState('ALL');
  const [clientQuery, setClientQuery] = useState('');
  const [search, setSearch] = useState('');
  const [now, setNow] = useState(() => Date.now());

  const running = pull?.status === 'running' || progress !== null;

  const mergeRows = useCallback((rows: Trade[], highlight = false) => {
    let changed = false;
    const fresh: string[] = [];
    for (const row of rows) {
      if (!mapRef.current.has(row.trade_id)) {
        mapRef.current.set(row.trade_id, row);
        fresh.push(row.trade_id);
        changed = true;
      }
    }
    if (!changed) return;
    setVersion((value) => value + 1);
    if (highlight && fresh.length > 0) {
      setSessionNew((value) => value + fresh.length);
      setNewIds((previous) => {
        const next = new Map(previous);
        const at = Date.now();
        for (const id of fresh) next.set(id, at);
        return next;
      });
    }
  }, []);

  const refreshMeta = useCallback(async () => {
    try {
      const [nextStats, nextPull] = await Promise.all([fetchStats(), fetchLatestPull()]);
      setStats(nextStats);
      setPull(nextPull);
      if (nextPull?.status === 'running') {
        setProgress((previous) =>
          previous ?? {
            ingested: nextPull.rowsIngested,
            inserted: nextPull.rowsInserted,
            rowsExpected: nextPull.rowsExpected,
            windowsDone: nextPull.windowsDone,
            windowsTotal: nextPull.windowsTotal
          }
        );
      }
    } catch {
      // Snapshot stays usable; the SSE reconnect banner covers transport issues.
    }
  }, []);

  // First paint comes from Postgres, never from the pull. A pull already in
  // progress on the server is irrelevant to how fast this renders.
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const first = await fetchTradesPage(PAGE_SIZE);
        if (cancelled) return;
        mergeRows(first.trades);
        setLoading(false);

        let cursor = first.nextCursor;
        let pages = 1;
        while (cursor && pages < MAX_PAGES) {
          const next = await fetchTradesPage(PAGE_SIZE, cursor);
          if (cancelled) return;
          mergeRows(next.trades);
          cursor = next.nextCursor;
          pages += 1;
        }
      } catch (loadError) {
        if (cancelled) return;
        setError(
          `Cannot reach the API at ${API_BASE}. Is it running? (${(loadError as Error).message})`
        );
        setLoading(false);
      }
    };

    void load();
    void refreshMeta();

    return () => {
      cancelled = true;
    };
  }, [mergeRows, refreshMeta]);

  // Server push only. EventSource reconnects on its own and the API replays
  // missed events via Last-Event-ID; there is no polling loop anywhere.
  useEffect(() => {
    const source = new EventSource(`${API_BASE}/events`);

    const parse = (event: MessageEvent): Record<string, unknown> | null => {
      try {
        return JSON.parse(event.data as string) as Record<string, unknown>;
      } catch {
        return null;
      }
    };

    source.onopen = () => {
      setConnection('live');
    };
    source.onerror = () => {
      setConnection('reconnecting');
    };

    const onStarted = (event: MessageEvent) => {
      const data = parse(event);
      if (!data) return;
      setProgress({
        ingested: 0,
        inserted: 0,
        rowsExpected: (data.rowsExpected as number | undefined) ?? null,
        windowsDone: 0,
        windowsTotal: (data.windowsTotal as number | undefined) ?? null
      });
      void refreshMeta();
    };

    const onSlice = (event: MessageEvent) => {
      const data = parse(event);
      if (!data) return;
      if (Array.isArray(data.rows)) mergeRows(data.rows as Trade[], true);
      setProgress((previous) => ({
        ingested: Number(data.ingested ?? previous?.ingested ?? 0),
        inserted: Number(data.inserted ?? previous?.inserted ?? 0),
        rowsExpected: (data.rowsExpected as number | undefined) ?? previous?.rowsExpected ?? null,
        windowsDone: previous?.windowsDone ?? 0,
        windowsTotal: (data.windowsTotal as number | undefined) ?? previous?.windowsTotal ?? null
      }));
    };

    const onProgress = (event: MessageEvent) => {
      const data = parse(event);
      if (!data) return;
      setProgress((previous) => ({
        ingested: Number(data.ingested ?? previous?.ingested ?? 0),
        inserted: Number(data.inserted ?? previous?.inserted ?? 0),
        rowsExpected: (data.rowsExpected as number | undefined) ?? previous?.rowsExpected ?? null,
        windowsDone: Number(data.windowsDone ?? previous?.windowsDone ?? 0),
        windowsTotal: (data.windowsTotal as number | undefined) ?? previous?.windowsTotal ?? null
      }));
    };

    const onCompleted = () => {
      setProgress(null);
      void refreshMeta();
    };

    const onFailed = (event: MessageEvent) => {
      const data = parse(event);
      setProgress(null);
      setError(`Pull failed: ${String(data?.error ?? 'unknown error')}. Start another pull to resume from the last committed slice.`);
      void refreshMeta();
    };

    source.addEventListener('pull.started', onStarted);
    source.addEventListener('slice.committed', onSlice);
    source.addEventListener('progress', onProgress);
    source.addEventListener('pull.completed', onCompleted);
    source.addEventListener('pull.failed', onFailed);

    return () => {
      source.close();
    };
  }, [mergeRows, refreshMeta]);

  // Cosmetic clock only; no network calls.
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  // Let the highlight fade, then forget the ids so the set stays small.
  useEffect(() => {
    if (newIds.size === 0) return;
    const timer = setTimeout(() => setNewIds(new Map()), 4500);
    return () => clearTimeout(timer);
  }, [newIds]);

  // "/" focuses the tape search without stealing keys from active fields.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'SELECT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);

      if (event.key === '/' && !typing) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const trades = useMemo(() => {
    return Array.from(mapRef.current.values()).sort((a, b) => {
      const delta = Date.parse(b.traded_at) - Date.parse(a.traded_at);
      if (delta !== 0) return delta;
      return a.trade_id < b.trade_id ? 1 : -1;
    });
  }, [version]);

  const symbols = useMemo(
    () => Array.from(new Set(trades.map((trade) => trade.symbol))).sort(),
    [trades]
  );

  const visibleTrades = useMemo(() => {
    const query = search.trim().toLowerCase();
    const client = clientQuery.trim().toLowerCase();
    if (!query && !client && symbol === 'ALL') return trades;
    return trades.filter((trade) => {
      if (symbol !== 'ALL' && trade.symbol !== symbol) return false;
      if (client && !trade.client.toLowerCase().includes(client)) return false;
      if (
        query &&
        !trade.trade_id.toLowerCase().includes(query) &&
        !trade.symbol.toLowerCase().includes(query) &&
        !trade.client.toLowerCase().includes(query)
      ) {
        return false;
      }
      return true;
    });
  }, [trades, symbol, clientQuery, search]);

  const totalTrades = Math.max(stats?.totalTrades ?? 0, trades.length);
  const isFiltered = symbol !== 'ALL' || clientQuery.trim() !== '' || search.trim() !== '';

  const elapsedMs = (() => {
    if (pull?.status === 'running' && pull.startedAt) return now - Date.parse(pull.startedAt);
    if (pull?.startedAt && pull?.finishedAt) {
      return Date.parse(pull.finishedAt) - Date.parse(pull.startedAt);
    }
    return 0;
  })();

  const windowPct =
    progress && progress.windowsTotal
      ? Math.min(100, Math.round((progress.windowsDone / progress.windowsTotal) * 100))
      : null;
  const rowPct =
    progress && progress.rowsExpected
      ? Math.min(100, Math.round((progress.ingested / progress.rowsExpected) * 100))
      : null;
  const pct = windowPct ?? rowPct;

  const onStartPull = async () => {
    setStarting(true);
    setError(null);
    try {
      await startPull();
      await refreshMeta();
    } catch (pullError) {
      const message = (pullError as Error).message;
      setError(
        message === 'pull_in_progress'
          ? 'A pull is already running on the server.'
          : `Could not start a pull: ${message}`
      );
      await refreshMeta();
    } finally {
      setStarting(false);
    }
  };

  const newIdSet = useMemo(() => new Set(newIds.keys()), [newIds]);

  return (
    <div className="relative flex min-h-dvh flex-col lg:h-dvh lg:overflow-hidden">
      <div className="ambient" aria-hidden="true" />

      <header className="sticky top-0 z-20 shrink-0 border-b border-line bg-canvas/80 backdrop-blur-sm">
        <div className="mx-auto flex h-16 w-full max-w-[1480px] items-center justify-between gap-4 px-5 sm:gap-6 sm:px-8">
          <div className="flex min-w-0 items-center gap-3.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface">
              <span className="font-serif text-[16px] leading-none tracking-[-0.02em] text-ink">B</span>
            </div>
            <div className="min-w-0 leading-tight">
              <p className="truncate text-[13px] font-medium tracking-[-0.01em] text-ink">Trade Tape</p>
              <p className="hidden truncate text-[11px] text-muted sm:block">BSE cash segment</p>
            </div>
            <span className="mx-2 hidden h-7 w-px bg-line sm:block" />
            <p className="num hidden text-[10px] tracking-[0.1em] text-faint uppercase sm:block">
              {stats?.maxTradedAt
                ? `Tape ends ${formatIST(stats.maxTradedAt)} IST`
                : 'Awaiting first print'}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2.5">
            <ConnectionPill state={connection} />
            <button
              type="button"
              onClick={() => void onStartPull()}
              disabled={running || starting}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-ink px-3.5 text-[12px] font-medium whitespace-nowrap text-white transition-colors hover:bg-[#333333] focus-visible:ring-2 focus-visible:ring-ink/20 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas focus-visible:outline-none active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-line-strong disabled:text-muted"
            >
              <IconPull className="h-3.5 w-3.5" />
              {running ? (
                <>
                  <span className="sm:hidden">Running</span>
                  <span className="hidden sm:inline">Pull running</span>
                </>
              ) : starting ? (
                'Starting…'
              ) : (
                <>
                  <span className="sm:hidden">Pull</span>
                  <span className="hidden sm:inline">Start pull</span>
                </>
              )}
            </button>
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto flex w-full max-w-[1480px] flex-1 flex-col px-5 pt-6 pb-4 sm:px-8 lg:min-h-0">
        {error && (
          <div
            role="alert"
            className="mb-4 flex shrink-0 items-start justify-between gap-4 rounded-lg border border-pale-red-ink/15 bg-pale-red px-4 py-2.5 text-[12px] text-pale-red-ink"
          >
            <span className="leading-relaxed">{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              aria-label="Dismiss error"
              className="mt-0.5 shrink-0 rounded p-0.5 opacity-60 transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-pale-red-ink/30 focus-visible:outline-none"
            >
              <IconClose className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        <Reveal className="shrink-0">
          <div className="flex flex-wrap items-end justify-between gap-5 pb-5">
            <div>
              <p className="micro flex items-center gap-2.5 text-faint">
                <span className="inline-block h-px w-6 bg-line-strong" />
                Cash segment · simulated tape
              </p>
              <h1 className="mt-2.5 max-w-xl font-serif text-[32px] leading-[1.06] tracking-[-0.03em] text-ink sm:text-[40px]">
                Every print,
                <span className="block text-ink-soft italic">as it lands.</span>
              </h1>
              <p className="mt-2.5 max-w-lg text-[12px] leading-relaxed text-muted">
                The full cash-segment tape, committed window by window and pushed to this screen
                over one long-lived connection. No refresh, no polling.
              </p>
            </div>

            <dl className="hidden items-end gap-6 pb-1 sm:flex">
              <div>
                <dt className="micro text-faint">Last print</dt>
                <dd className="num mt-1.5 text-[11px] text-ink">
                  {stats?.maxTradedAt ? `${formatIST(stats.maxTradedAt)} IST` : '—'}
                </dd>
              </div>
              <div className="h-8 w-px bg-line" />
              <div>
                <dt className="micro text-faint">Transport</dt>
                <dd className="mt-1.5 text-[11px] text-ink">SSE · keyset paging</dd>
              </div>
            </dl>
          </div>
        </Reveal>

        <div className="flex min-h-0 flex-1 flex-col gap-3 xl:flex-row">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
            <section
              aria-label="Tape summary"
              className="grid shrink-0 grid-cols-2 gap-3 lg:grid-cols-12"
            >
              <StatCard
                className="col-span-2 h-full lg:col-span-4"
                label="Trades stored"
                value={formatQty(totalTrades)}
                detail="rows committed to Postgres"
                index={0}
              />
              <StatCard
                className="h-full lg:col-span-3"
                label="Symbols"
                value={formatQty(symbols.length)}
                detail="distinct scrips on the tape"
                index={1}
              />
              <StatCard
                className="h-full lg:col-span-2"
                label="New session"
                value={formatQty(sessionNew)}
                detail="arrived over SSE"
                badge={sessionNew > 0 ? <Badge tone="green">live</Badge> : undefined}
                index={2}
              />
              <StatCard
                className="col-span-2 h-full lg:col-span-3"
                label="Latest pull"
                value={statusLabel(pull?.status)}
                detail={
                  pull
                    ? `${plural(
                        pull.status === 'running'
                          ? (progress?.ingested ?? pull.rowsIngested)
                          : pull.rowsIngested,
                        'row'
                      )} · ${formatDuration(elapsedMs)}`
                    : 'nothing pulled yet'
                }
                badge={
                  <Badge tone={statusTone(pull?.status)}>
                    {pull ? (pull.status === 'running' ? 'live' : 'last run') : 'idle'}
                  </Badge>
                }
                index={3}
              />
            </section>

            {running && progress && (
              <Reveal delay={80} className="mt-3 shrink-0">
                <section
                  aria-live="polite"
                  className="rounded-xl border border-line bg-surface px-5 py-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <span className="soft-pulse h-1.5 w-1.5 rounded-full bg-pale-yellow-ink" />
                      <span className="text-[12.5px] font-medium text-ink">Pulling in slices</span>
                      <span className="num text-[10.5px] text-muted">
                        {progress.windowsTotal
                          ? `${progress.windowsDone}/${progress.windowsTotal} windows`
                          : 'planning windows'}
                      </span>
                    </div>
                    <div className="num text-[10.5px] text-muted">
                      {formatQty(progress.ingested)}
                      {progress.rowsExpected ? ` / ${formatQty(progress.rowsExpected)}` : ''} rows ·{' '}
                      {formatDuration(elapsedMs)} elapsed
                    </div>
                  </div>

                  <div
                    role="progressbar"
                    aria-label="Pull progress"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={pct ?? undefined}
                    className="mt-3 h-[3px] w-full overflow-hidden rounded-full bg-canvas"
                  >
                    <div
                      className={`h-full w-full origin-left rounded-full bg-ink transition-transform duration-500 ease-out ${
                        pct === null ? 'animate-pulse' : ''
                      }`}
                      style={{ transform: `scaleX(${pct === null ? 0.28 : Math.max(0.02, pct / 100)})` }}
                    />
                  </div>

                  <p className="mt-2.5 text-[10.5px] leading-relaxed text-faint">
                    Each request stays under the 30-second socket cap. Rows and the cursor commit in one
                    transaction, so a failure resumes rather than restarts.
                  </p>
                </section>
              </Reveal>
            )}

            <Reveal delay={220} className="mt-4 shrink-0">
              <section aria-label="Tape filters" className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <label className="sr-only" htmlFor="symbol-filter">
                    Filter by symbol
                  </label>
                  <select
                    id="symbol-filter"
                    value={symbol}
                    onChange={(event) => setSymbol(event.target.value)}
                    className="h-9 appearance-none rounded-md border border-line bg-surface pr-8 pl-3 text-[12px] text-ink transition-colors hover:border-line-strong focus:border-ink/30 focus-visible:ring-2 focus-visible:ring-ink/10 focus-visible:outline-none"
                  >
                    <option value="ALL">All symbols</option>
                    {symbols.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                  <IconChevronDown className="pointer-events-none absolute top-1/2 right-2.5 h-3 w-3 -translate-y-1/2 text-faint" />
                </div>

                <input
                  value={clientQuery}
                  onChange={(event) => setClientQuery(event.target.value)}
                  placeholder="Client"
                  aria-label="Filter by client"
                  className="h-9 w-36 rounded-md border border-line bg-surface px-3 text-[12px] text-ink transition-colors placeholder:text-faint hover:border-line-strong focus:border-ink/30 focus-visible:ring-2 focus-visible:ring-ink/10 focus-visible:outline-none"
                />

                <div className="relative">
                  <IconSearch className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
                  <input
                    ref={searchRef}
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Trade ID, symbol or client"
                    aria-label="Search trades"
                    className="h-9 w-[248px] rounded-md border border-line bg-surface pr-9 pl-9 text-[12px] text-ink transition-colors placeholder:text-faint hover:border-line-strong focus:border-ink/30 focus-visible:ring-2 focus-visible:ring-ink/10 focus-visible:outline-none"
                  />
                  {search === '' && (
                    <kbd className="num pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded border border-line bg-canvas px-1.5 py-0.5 text-[9.5px] leading-none text-faint sm:block">
                      /
                    </kbd>
                  )}
                </div>

                {isFiltered && (
                  <button
                    type="button"
                    onClick={() => {
                      setSymbol('ALL');
                      setClientQuery('');
                      setSearch('');
                    }}
                    className="inline-flex h-9 items-center gap-1.5 rounded-md border border-line px-3 text-[11.5px] text-muted transition-colors hover:border-line-strong hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/15 focus-visible:outline-none"
                  >
                    <IconClose className="h-3 w-3" />
                    Clear
                  </button>
                )}

                <p className="num ml-auto hidden text-[10px] tracking-[0.08em] text-faint uppercase md:block">
                  {visibleTrades.length < trades.length
                    ? `${formatQty(visibleTrades.length)} / ${formatQty(trades.length)} rows`
                    : `${formatQty(trades.length)} rows`}
                </p>
              </section>
            </Reveal>

            <Reveal delay={320} className="mt-3 flex h-[520px] flex-col lg:h-auto lg:min-h-0 lg:flex-1">
              <TradeTable
                rows={visibleTrades}
                newIds={newIdSet}
                loading={loading}
                total={trades.length}
                filtered={isFiltered}
              />
            </Reveal>
          </div>
          <SideRail trades={trades} windowsTotal={pull?.windowsTotal ?? null} />
        </div>
      </main>
    </div>
  );
}

function StatCard({
  label,
  value,
  detail,
  badge,
  className = '',
  index = 0
}: {
  label: string;
  value: string;
  detail: string;
  badge?: React.ReactNode;
  className?: string;
  index?: number;
}) {
  return (
    <Reveal delay={80 + index * 70} className={className}>
      <div className="flex h-full flex-col justify-between rounded-xl border border-line bg-surface px-5 py-3.5 transition-shadow duration-200 hover:shadow-[0_2px_8px_rgba(0,0,0,0.04)]">
        <div className="flex items-start justify-between gap-3">
          <p className="micro pt-0.5 text-faint">{label}</p>
          {badge}
        </div>
        <div className="mt-4">
          <p className="num truncate text-[21px] leading-none tracking-[-0.01em] text-ink">{value}</p>
          <p className="mt-2 text-[11px] text-muted">{detail}</p>
        </div>
      </div>
    </Reveal>
  );
}

function Badge({
  children,
  tone = 'neutral'
}: {
  children: React.ReactNode;
  tone?: Tone;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[9px] font-medium tracking-[0.12em] uppercase ${TONES[tone]}`}
    >
      <span className="h-1 w-1 rounded-full bg-current" />
      {children}
    </span>
  );
}

function ConnectionPill({ state }: { state: ConnectionState }) {
  const label =
    state === 'live' ? 'Live' : state === 'reconnecting' ? 'Reconnecting' : 'Connecting';
  const dot =
    state === 'live'
      ? 'bg-pale-green-ink'
      : state === 'reconnecting'
        ? 'bg-pale-yellow-ink'
        : 'bg-faint';

  return (
    <span
      aria-live="polite"
      className="inline-flex h-9 items-center gap-2 rounded-full border border-line bg-surface px-3 text-[9px] font-medium tracking-[0.14em] text-muted uppercase"
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${dot} ${state === 'live' ? 'soft-pulse' : ''}`}
      />
      <span className="hidden sm:inline">{label}</span>
      <span className="sr-only sm:hidden">{label}</span>
    </span>
  );
}

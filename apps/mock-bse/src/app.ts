import express, { type Express, type Request, type Response } from 'express';
import { MockStore, decodeCursor, type MockOptions } from './store';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function parseMs(value: unknown, fallback: number): number {
  const raw = asString(value);
  if (!raw) return fallback;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new Error(`invalid timestamp: ${raw}`);
  return parsed;
}

function parseLimit(value: unknown, fallback: number, max: number): number {
  const raw = asString(value);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`invalid limit: ${raw}`);
  return Math.min(parsed, max);
}

function serialize(trade: {
  trade_id: string;
  client: string;
  symbol: string;
  quantity: number;
  price: number;
  traded_at: number;
}) {
  return { ...trade, traded_at: new Date(trade.traded_at).toISOString() };
}

export interface MockApp {
  app: Express;
  store: MockStore;
}

/**
 * Builds the fake BSE service. The 30 second cut is enforced for real: if a
 * response is still being produced when MOCK_MAX_RESPONSE_MS elapses, the
 * socket is destroyed. Sizing pages below the cap is therefore mandatory for
 * the consumer, not a convention.
 */
export function createMockApp(overrides: Partial<MockOptions> = {}): MockApp {
  const store = new MockStore({
    seedCount: 5000,
    msPerRow: 180,
    maxResponseMs: 30_000,
    failRate: 0,
    ...overrides
  });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      totalTrades: store.trades.length,
      msPerRow: store.options.msPerRow,
      maxResponseMs: store.options.maxResponseMs,
      failNext: store.failNext
    });
  });

  app.get('/meta', (_req, res) => {
    res.json(store.meta());
  });

  app.get('/getTrades', async (req: Request, res: Response) => {
    const startedAt = Date.now();

    if (store.failNext > 0) {
      store.failNext -= 1;
      res.status(503).json({ error: 'upstream_unavailable', retryable: true });
      return;
    }
    if (store.options.failRate > 0 && Math.random() < store.options.failRate) {
      res.status(503).json({ error: 'upstream_unavailable', retryable: true });
      return;
    }

    const meta = store.meta();
    let from: number;
    let to: number;
    let limit: number;
    try {
      from = parseMs(req.query.from, Date.parse(meta.minTs));
      to = parseMs(req.query.to, Date.parse(meta.maxTs) + 1);
      limit = parseLimit(req.query.limit, 500, 1000);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
      return;
    }

    if (to <= from) {
      res.status(400).json({ error: 'to must be greater than from' });
      return;
    }

    const rawCursor = asString(req.query.cursor);
    const cursor = rawCursor ? decodeCursor(rawCursor) : null;
    if (rawCursor && !cursor) {
      res.status(400).json({ error: 'invalid cursor' });
      return;
    }

    const { rows, nextCursor, totalInWindow } = store.query({ from, to, limit, cursor });

    // Throughput model: a slice costs time proportional to the rows returned.
    // A page that is too large simply dies on the socket cap below.
    const delayMs = Math.max(1, rows.length * store.options.msPerRow);
    const killTimer = setTimeout(() => {
      if (!res.writableEnded) {
        res.destroy();
      }
    }, store.options.maxResponseMs);
    killTimer.unref?.();

    await sleep(delayMs);
    clearTimeout(killTimer);

    if (res.destroyed || res.writableEnded) return;

    if (store.options.failRate >= 1) {
      res.status(503).json({ error: 'upstream_unavailable', retryable: true });
      return;
    }

    try {
      res.json({
        trades: rows.map(serialize),
        nextCursor,
        rows: rows.length,
        totalInWindow,
        window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
        delayMs,
        servedInMs: Date.now() - startedAt
      });
    } catch {
      // Client vanished (e.g. our own kill timer); nothing to do.
    }

    if (process.env.MOCK_VERBOSE === 'true') {
      console.log(
        `[mock] getTrades rows=${rows.length} window=${new Date(from).toISOString()}..${new Date(to).toISOString()} ms=${Date.now() - startedAt}`
      );
    }
  });

  // Demo / test helpers. Never called by the ingestion worker.
  app.post('/__admin/burst', (req, res) => {
    let count = 250;
    try {
      const raw = asString(req.query.count) ?? (req.body as { count?: unknown } | undefined)?.count;
      if (raw !== undefined) count = parseLimit(raw, 250, 5000);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
      return;
    }
    const added = store.burst(count);
    res.json({ added, total: store.trades.length, maxTs: store.meta().maxTs });
  });

  app.post('/__admin/fail-next', (req, res) => {
    const raw = asString(req.query.count) ?? (req.body as { count?: unknown } | undefined)?.count ?? 1;
    const count = Math.max(1, Number.parseInt(String(raw), 10) || 1);
    store.failNext = count;
    res.json({ failNext: store.failNext });
  });

  app.post('/__admin/reset', (_req, res) => {
    store.reset();
    res.json({ ok: true, total: store.trades.length });
  });

  app.use((error: Error, _req: Request, res: Response, _next: unknown) => {
    res.status(500).json({ error: error.message });
  });

  return { app, store };
}

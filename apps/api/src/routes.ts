import express, { type Express, type Request, type Response } from 'express';
import { config } from './config';
import { query } from './db';
import { hub, type AppEvent } from './events';
import { PullConflictError, startPull } from './puller';

interface TradeRow {
  trade_id: string;
  client: string;
  symbol: string;
  quantity: number;
  price: string;
  traded_at: Date;
}

interface PullRow {
  id: string;
  status: string;
  started_at: Date;
  finished_at: Date | null;
  window_from: Date | null;
  window_to: Date | null;
  cursor_ts: Date | null;
  cursor_id: string | null;
  rows_ingested: number;
  rows_inserted: number;
  rows_expected: number | null;
  windows_total: number | null;
  windows_done: number;
  error: string | null;
}

function serializePull(pull: PullRow) {
  return {
    id: pull.id,
    status: pull.status,
    startedAt: pull.started_at.toISOString(),
    finishedAt: pull.finished_at ? pull.finished_at.toISOString() : null,
    windowFrom: pull.window_from ? pull.window_from.toISOString() : null,
    windowTo: pull.window_to ? pull.window_to.toISOString() : null,
    cursorTs: pull.cursor_ts ? pull.cursor_ts.toISOString() : null,
    cursorId: pull.cursor_id,
    rowsIngested: pull.rows_ingested,
    rowsInserted: pull.rows_inserted,
    rowsExpected: pull.rows_expected,
    windowsTotal: pull.windows_total,
    windowsDone: pull.windows_done,
    error: pull.error
  };
}

function serializeTrade(row: TradeRow) {
  return {
    trade_id: row.trade_id,
    client: row.client,
    symbol: row.symbol,
    quantity: row.quantity,
    price: Number(row.price),
    traded_at: row.traded_at.toISOString()
  };
}

function writeEvent(res: Response, event: AppEvent): void {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
  } catch {
    // The socket is gone; the close handler will clean up.
  }
}

function cors(req: Request, res: Response, next: () => void): void {
  const origin = req.headers.origin;
  const allowed =
    origin &&
    (config.frontendOrigins.includes('*') || config.frontendOrigins.includes(origin));
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Last-Event-ID');
  res.setHeader('Access-Control-Expose-Headers', 'Last-Event-ID');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

export function createApiApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.use(express.json());
  app.use(cors);

  // Live data: a cached 304 would make the dashboard look empty after reload.
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      const detail =
        req.method === 'POST'
          ? ` ua="${String(req.headers['user-agent'] ?? '-').slice(0, 40)}" ref="${String(req.headers.referer ?? '-')}"`
          : '';
      console.log(
        `[api] ${new Date().toISOString()} ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - startedAt}ms)${detail}`
      );
    });
    next();
  });

  app.get('/health', async (_req, res) => {
    let db = 'ok';
    let mock = 'unknown';
    try {
      await query('SELECT 1');
    } catch {
      db = 'down';
    }
    try {
      const response = await fetch(`${config.mockUrl}/health`, {
        signal: AbortSignal.timeout(1500)
      });
      mock = response.ok ? 'ok' : `http_${response.status}`;
    } catch {
      mock = 'unreachable';
    }
    res.status(db === 'ok' ? 200 : 503).json({ ok: db === 'ok', db, mock, uptimeSec: Math.round(process.uptime()) });
  });

  app.get('/trades', async (req, res) => {
    const limitRaw = Number(req.query.limit ?? 500);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 500, 1), 5000);

    const cursorTs = typeof req.query.cursorTs === 'string' ? req.query.cursorTs : null;
    const cursorId = typeof req.query.cursorId === 'string' ? req.query.cursorId : null;

    const params: unknown[] = [];
    let where = '';
    if (cursorTs && cursorId) {
      params.push(cursorTs, cursorId);
      where = `WHERE (traded_at, trade_id) < ($1::timestamptz, $2::text)`;
    }
    params.push(limit + 1);

    const result = await query<TradeRow>(
      `SELECT trade_id, client, symbol, quantity, price, traded_at
         FROM trades
         ${where}
         ORDER BY traded_at DESC, trade_id DESC
         LIMIT $${params.length}`,
      params
    );

    const hasMore = result.rows.length > limit;
    const page = hasMore ? result.rows.slice(0, limit) : result.rows;
    const last = page[page.length - 1];

    res.json({
      trades: page.map(serializeTrade),
      nextCursor:
        hasMore && last ? { ts: last.traded_at.toISOString(), id: last.trade_id } : null
    });
  });

  app.get('/stats', async (_req, res) => {
    const totals = await query<{
      total: number;
      symbols: number;
      min_ts: Date | null;
      max_ts: Date | null;
    }>(
      `SELECT count(*)::int AS total,
              count(DISTINCT symbol)::int AS symbols,
              min(traded_at) AS min_ts,
              max(traded_at) AS max_ts
         FROM trades`
    );
    const latest = await query<PullRow>(`SELECT * FROM pulls ORDER BY started_at DESC LIMIT 1`);
    const row = totals.rows[0];

    res.json({
      totalTrades: row?.total ?? 0,
      symbolCount: row?.symbols ?? 0,
      minTradedAt: row?.min_ts ? row.min_ts.toISOString() : null,
      maxTradedAt: row?.max_ts ? row.max_ts.toISOString() : null,
      latestPull: latest.rows[0] ? serializePull(latest.rows[0]) : null
    });
  });

  app.get('/pulls/latest', async (_req, res) => {
    const result = await query<PullRow>(`SELECT * FROM pulls ORDER BY started_at DESC LIMIT 1`);
    const pull = result.rows[0];
    res.json({ pull: pull ? serializePull(pull) : null });
  });

  app.get('/pulls/:id', async (req, res) => {
    const result = await query<PullRow>(`SELECT * FROM pulls WHERE id = $1`, [req.params.id]);
    const pull = result.rows[0];
    if (!pull) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ pull: serializePull(pull) });
  });

  app.post('/pulls', async (_req, res) => {
    try {
      const pullId = await startPull();
      res.status(202).json({ pullId, status: 'running' });
    } catch (error) {
      if (error instanceof PullConflictError) {
        res.status(409).json({ error: 'pull_in_progress', pullId: error.activePullId });
        return;
      }
      console.error('[api] failed to start pull', error);
      res.status(500).json({ error: 'failed_to_start_pull' });
    }
  });

  /**
   * Server-sent events. Every event is persisted first, so Last-Event-ID
   * replays anything the browser missed (laptop sleep, API restart, flaky
   * wifi) without the client polling for it.
   */
  app.get('/events', async (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();
    res.write(`retry: 2000\n\n`);

    const rawLast = req.headers['last-event-id'] ?? req.query.lastEventId;
    const lastId = Number(Array.isArray(rawLast) ? rawLast[0] : rawLast);
    if (Number.isFinite(lastId) && lastId > 0) {
      const missed = await query<{ id: string; type: string; payload: unknown }>(
        `SELECT id, type, payload FROM events WHERE id > $1 ORDER BY id ASC LIMIT 1000`,
        [lastId]
      );
      for (const row of missed.rows) {
        writeEvent(res, { id: Number(row.id), type: row.type, payload: row.payload });
      }
    }

    const unsubscribe = hub.subscribe((event) => writeEvent(res, event));

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(`: heartbeat ${Date.now()}\n\n`);
    }, config.sseHeartbeatMs);
    heartbeat.unref?.();

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on('close', cleanup);
    res.on('error', cleanup);
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  return app;
}

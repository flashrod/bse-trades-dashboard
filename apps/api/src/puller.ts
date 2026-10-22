import { randomUUID } from 'node:crypto';
import { query, withTransaction } from './db';
import { config } from './config';
import { emitEvent } from './events';

export interface MockTradeWire {
  trade_id: string;
  client: string;
  symbol: string;
  quantity: number;
  price: number;
  traded_at: string;
}

interface MockMeta {
  minTs: string;
  maxTs: string;
  totalTrades: number;
  tradesPerHour: number;
  msPerRow: number;
  maxResponseMs: number;
  estimatedFullPullMs: number;
}

interface MockPage {
  trades: MockTradeWire[];
  nextCursor: string | null;
  rows: number;
  totalInWindow: number;
}

export interface PullOptions {
  mockUrl: string;
  sliceHours: number;
  pageLimit: number;
  requestTimeoutMs: number;
  maxAttempts: number;
  windowOverlapMs: number;
  /** Test/backfill hook: ignore the database watermark and start here. */
  startFromMs?: number;
}

export class PullConflictError extends Error {
  constructor(readonly activePullId: string | null) {
    super('a pull is already running');
    this.name = 'PullConflictError';
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function planWindows(from: number, to: number, sliceHours: number): Array<{ from: number; to: number }> {
  const step = Math.max(1, sliceHours) * 3_600_000;
  const windows: Array<{ from: number; to: number }> = [];
  let cursor = from;
  while (cursor < to) {
    windows.push({ from: cursor, to: Math.min(cursor + step, to) });
    cursor += step;
  }
  return windows;
}

function defaultOptions(): PullOptions {
  return {
    mockUrl: config.mockUrl,
    sliceHours: config.sliceHours,
    pageLimit: config.pageLimit,
    requestTimeoutMs: config.requestTimeoutMs,
    maxAttempts: config.maxAttempts,
    windowOverlapMs: config.windowOverlapMs
  };
}

async function getJson<T>(url: string, options: PullOptions, attempt = 1): Promise<T> {
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(options.requestTimeoutMs)
    });
    if (!response.ok) {
      throw new Error(`upstream responded ${response.status}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (attempt >= options.maxAttempts) {
      throw new Error(`request failed after ${attempt} attempts: ${(error as Error).message}`);
    }
    // 250ms, 500ms, 1s... A killed socket and a 503 are treated identically:
    // the page is simply requested again.
    await sleep(250 * 2 ** (attempt - 1));
    return getJson<T>(url, options, attempt + 1);
  }
}

/** Commits one page of trades and the cursor in the same transaction. */
async function commitPage(
  pullId: string,
  rows: MockTradeWire[],
  windowsDone: number
): Promise<number> {
  const columns = 8;
  const placeholders: string[] = [];
  const values: unknown[] = [];

  rows.forEach((row, index) => {
    const base = index * columns;
    placeholders.push(
      `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8})`
    );
    values.push(
      row.trade_id,
      row.client,
      row.symbol,
      row.quantity,
      row.price,
      row.traded_at,
      pullId,
      pullId
    );
  });

  const last = rows[rows.length - 1]!;

  return withTransaction(async (client) => {
    const result = await client.query<{ is_new: boolean }>(
      `INSERT INTO trades (trade_id, client, symbol, quantity, price, traded_at, first_pull_id, last_pull_id)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (trade_id) DO UPDATE SET last_pull_id = EXCLUDED.last_pull_id
       RETURNING (xmax = 0) AS is_new`,
      values
    );

    const inserted = result.rows.filter((row) => row.is_new).length;

    // Cursor and rows move together: a crash can never leave a cursor that
    // points past data we did not persist.
    await client.query(
      `UPDATE pulls
          SET rows_ingested = rows_ingested + $2,
              rows_inserted = rows_inserted + $3,
              cursor_ts = $4::timestamptz,
              cursor_id = $5,
              windows_done = $6
        WHERE id = $1`,
      [pullId, rows.length, inserted, last.traded_at, last.trade_id, windowsDone]
    );

    return inserted;
  });
}

/**
 * Pulls the mock BSE tape in short windows and commits every page atomically.
 * Restarting a pull (POST /pulls again) resumes from max(traded_at) in the
 * database, so a failure never loses or duplicates rows.
 */
export async function runPull(pullId: string, overrides: Partial<PullOptions> = {}): Promise<void> {
  const options: PullOptions = { ...defaultOptions(), ...overrides };
  const startedAt = Date.now();
  let ingested = 0;
  let inserted = 0;

  try {
    const meta = await getJson<MockMeta>(`${options.mockUrl}/meta`, options);
    // Half-open windows everywhere, so nudge past the newest timestamp or the
    // final trade would be excluded by `traded_at < to`.
    const to = Date.parse(meta.maxTs) + 1;
    const minTs = Date.parse(meta.minTs);

    let from: number;
    if (typeof options.startFromMs === 'number') {
      from = options.startFromMs;
    } else {
      const watermark = await query<{ last: Date | null }>(`SELECT max(traded_at) AS last FROM trades`);
      const rawLast = watermark.rows[0]?.last ?? null;
      const lastMs = rawLast ? new Date(rawLast).getTime() : null;
      from = lastMs === null ? minTs : Math.max(minTs, lastMs - options.windowOverlapMs);
    }

    const windows = planWindows(from, to, options.sliceHours);
    const rowsExpected = Math.max(
      0,
      Math.round((meta.tradesPerHour * Math.max(0, to - from)) / 3_600_000)
    );

    await query(
      `UPDATE pulls
          SET window_from = $2::timestamptz,
              window_to = $3::timestamptz,
              rows_expected = $4,
              windows_total = $5
        WHERE id = $1`,
      [pullId, new Date(from).toISOString(), new Date(to).toISOString(), rowsExpected, windows.length]
    );

    await emitEvent('pull.started', {
      pullId,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      windowsTotal: windows.length,
      rowsExpected,
      startedAt: new Date().toISOString()
    });

    for (let windowIndex = 0; windowIndex < windows.length; windowIndex += 1) {
      const window = windows[windowIndex]!;
      let cursor: string | null = null;

      do {
        const url = new URL(`${options.mockUrl}/getTrades`);
        url.searchParams.set('from', new Date(window.from).toISOString());
        url.searchParams.set('to', new Date(window.to).toISOString());
        url.searchParams.set('limit', String(options.pageLimit));
        if (cursor) url.searchParams.set('cursor', cursor);

        const page = await getJson<MockPage>(url.toString(), options);
        const rows = page.trades ?? [];

        if (rows.length > 0) {
          inserted += await commitPage(pullId, rows, windowIndex);
        }
        ingested += rows.length;
        cursor = page.nextCursor;

        await emitEvent('slice.committed', {
          pullId,
          window: { from: new Date(window.from).toISOString(), to: new Date(window.to).toISOString() },
          rows,
          ingested,
          inserted,
          rowsExpected,
          windowsDone: windowIndex,
          windowsTotal: windows.length
        });
      } while (cursor);

      await query(`UPDATE pulls SET windows_done = $2 WHERE id = $1`, [pullId, windowIndex + 1]);
      await emitEvent('progress', {
        pullId,
        ingested,
        inserted,
        rowsExpected,
        windowsDone: windowIndex + 1,
        windowsTotal: windows.length
      });
    }

    await query(`UPDATE pulls SET status = 'completed', finished_at = now(), error = NULL WHERE id = $1`, [
      pullId
    ]);

    const total = await query<{ count: number }>(`SELECT count(*)::int AS count FROM trades`);
    await emitEvent('pull.completed', {
      pullId,
      ingested,
      inserted,
      durationMs: Date.now() - startedAt,
      windowsTotal: windows.length,
      totalTrades: total.rows[0]?.count ?? 0
    });
  } catch (error) {
    const message = (error as Error).message;
    await query(`UPDATE pulls SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [
      pullId,
      message
    ]).catch(() => undefined);
    await emitEvent('pull.failed', { pullId, error: message, ingested, inserted }).catch(() => undefined);
    throw error;
  }
}

/** Creates the run row (single-flight enforced by a partial unique index) and starts it. */
export async function startPull(): Promise<string> {
  const pullId = randomUUID();
  try {
    await query(`INSERT INTO pulls (id, status, started_at) VALUES ($1, 'running', now())`, [pullId]);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      const active = await query<{ id: string }>(
        `SELECT id FROM pulls WHERE status = 'running' LIMIT 1`
      );
      throw new PullConflictError(active.rows[0]?.id ?? null);
    }
    throw error;
  }

  void runPull(pullId).catch((error) => {
    console.error(`[pull] ${pullId} failed: ${(error as Error).message}`);
  });

  return pullId;
}

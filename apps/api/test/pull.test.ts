import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockApp } from '../../mock-bse/src/app';
import type { MockStore } from '../../mock-bse/src/store';
import { closePool, query } from '../src/db';
import { migrate } from '../src/migrate';
import { planWindows, runPull, type PullOptions } from '../src/puller';

let server: Server;
let mockUrl = '';
let store: MockStore;

const baseOptions = (): PullOptions => ({
  mockUrl,
  sliceHours: 24,
  pageLimit: 50,
  requestTimeoutMs: 5000,
  maxAttempts: 3,
  windowOverlapMs: 0
});

async function createPull(): Promise<string> {
  // A previous test's timeout must not poison the single-flight index.
  await query(`UPDATE pulls SET status = 'interrupted', finished_at = now() WHERE status = 'running'`);
  const id = randomUUID();
  await query(`INSERT INTO pulls (id, status, started_at) VALUES ($1, 'running', now())`, [id]);
  return id;
}

async function tradeCount(): Promise<number> {
  const result = await query<{ total: number; distinct: number }>(
    `SELECT count(*)::int AS total, count(DISTINCT trade_id)::int AS distinct FROM trades`
  );
  return result.rows[0]!.total;
}

beforeAll(async () => {
  await migrate();
  await query(`TRUNCATE trades, pulls, events`);

  const mock = createMockApp({ seedCount: 480, msPerRow: 1, maxResponseMs: 30_000, failRate: 0 });
  store = mock.store;
  server = mock.app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  mockUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePool();
});

describe('planWindows', () => {
  it('covers the range exactly with no gaps or overlaps', () => {
    const from = Date.parse('2026-01-01T00:00:00Z');
    const to = Date.parse('2026-01-03T06:00:00Z');
    const windows = planWindows(from, to, 12);

    expect(windows).toHaveLength(5);
    expect(windows[0]!.from).toBe(from);
    expect(windows[windows.length - 1]!.to).toBe(to);
    for (let i = 1; i < windows.length; i += 1) {
      expect(windows[i]!.from).toBe(windows[i - 1]!.to);
    }
  });

  it('returns nothing for an empty range', () => {
    expect(planWindows(100, 100, 12)).toHaveLength(0);
    expect(planWindows(200, 100, 12)).toHaveLength(0);
  });
});

describe('pull pipeline', () => {
  it('ingests the whole tape and marks the pull completed', async () => {
    const id = await createPull();
    await runPull(id, baseOptions());

    expect(await tradeCount()).toBe(480);

    const pull = await query<{ status: string; windows_total: number; rows_ingested: number }>(
      `SELECT status, windows_total, rows_ingested FROM pulls WHERE id = $1`,
      [id]
    );
    expect(pull.rows[0]!.status).toBe('completed');
    expect(pull.rows[0]!.windows_total).toBe(30);
    expect(pull.rows[0]!.rows_ingested).toBe(480);
  }, 30_000);

  it('is idempotent: re-ingesting the same tape inserts nothing', async () => {
    const id = await createPull();
    await runPull(id, {
      ...baseOptions(),
      startFromMs: Date.parse(store.meta().minTs) - 1000
    });

    expect(await tradeCount()).toBe(480);

    const pull = await query<{ status: string; rows_inserted: number; rows_ingested: number }>(
      `SELECT status, rows_inserted, rows_ingested FROM pulls WHERE id = $1`,
      [id]
    );
    expect(pull.rows[0]!.status).toBe('completed');
    expect(pull.rows[0]!.rows_ingested).toBe(480);
    expect(pull.rows[0]!.rows_inserted).toBe(0);
  }, 30_000);

  it('resumes after an exhausted failure without losing or duplicating rows', async () => {
    const added = store.burst(120);
    expect(added).toBe(120);

    store.failNext = 3; // three attempts on the first page, all 503
    const failedId = await createPull();
    await expect(runPull(failedId, baseOptions())).rejects.toThrow(/failed after 3 attempts/);

    const failed = await query<{ status: string; error: string }>(
      `SELECT status, error FROM pulls WHERE id = $1`,
      [failedId]
    );
    expect(failed.rows[0]!.status).toBe('failed');
    expect(failed.rows[0]!.error).toMatch(/failed after 3 attempts/);

    // Pressing "Pull" again is the resume: it starts from the durable watermark.
    const resumedId = await createPull();
    await runPull(resumedId, baseOptions());

    expect(await tradeCount()).toBe(store.trades.length);

    const integrity = await query<{ total: number; distinct: number }>(
      `SELECT count(*)::int AS total, count(DISTINCT trade_id)::int AS distinct FROM trades`
    );
    expect(integrity.rows[0]!.total).toBe(integrity.rows[0]!.distinct);

    const resumed = await query<{ status: string }>(`SELECT status FROM pulls WHERE id = $1`, [resumedId]);
    expect(resumed.rows[0]!.status).toBe('completed');
  }, 30_000);

  it('enforces the connection cap: oversized pages die and the pull fails cleanly', async () => {
    const slow = createMockApp({ seedCount: 40, msPerRow: 1000, maxResponseMs: 150, failRate: 0 });
    const slowServer = slow.app.listen(0);
    await new Promise<void>((resolve) => slowServer.once('listening', () => resolve()));
    const address = slowServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const id = await createPull();
      await expect(
        runPull(id, {
          ...baseOptions(),
          mockUrl: `http://127.0.0.1:${port}`,
          sliceHours: 24 * 40,
          pageLimit: 500,
          startFromMs: Date.parse(slow.store.meta().minTs) - 1000
        })
      ).rejects.toThrow();

      const pull = await query<{ status: string }>(`SELECT status FROM pulls WHERE id = $1`, [id]);
      expect(pull.rows[0]!.status).toBe('failed');
    } finally {
      await new Promise<void>((resolve) => slowServer.close(() => resolve()));
    }
  }, 30_000);
});

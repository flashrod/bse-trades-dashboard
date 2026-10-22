import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
}

export const config = {
  port: num(process.env.PORT, 4000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://bse:bse@localhost:5433/bse',
  mockUrl: ((): string => {
    const raw = process.env.MOCK_URL ?? 'http://localhost:4001';
    const withScheme = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
    return withScheme.replace(/\/$/, '');
  })(),
  frontendOrigins: (process.env.FRONTEND_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  sliceHours: num(process.env.PULL_SLICE_HOURS, 12),
  pageLimit: num(process.env.PULL_PAGE_LIMIT, 80),
  requestTimeoutMs: num(process.env.PULL_REQUEST_TIMEOUT_MS, 20_000),
  maxAttempts: num(process.env.PULL_MAX_ATTEMPTS, 3),
  windowOverlapMs: num(process.env.PULL_WINDOW_OVERLAP_MS, 5000),
  autoStartPull: bool(process.env.AUTO_START_PULL, false),
  sseHeartbeatMs: num(process.env.SSE_HEARTBEAT_MS, 15_000)
};

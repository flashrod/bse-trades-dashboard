import type { Pull, Stats, Trade } from './types';

export const API_BASE = (
  (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000'
).replace(/\/$/, '');

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`GET ${path} failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

export interface TradePage {
  trades: Trade[];
  nextCursor: { ts: string; id: string } | null;
}

export function fetchTradesPage(
  limit = 1000,
  cursor?: { ts: string; id: string } | null
): Promise<TradePage> {
  const cursorPart = cursor
    ? `&cursorTs=${encodeURIComponent(cursor.ts)}&cursorId=${encodeURIComponent(cursor.id)}`
    : '';
  return getJson<TradePage>(`/trades?limit=${limit}${cursorPart}`);
}

export const fetchStats = () => getJson<Stats>('/stats');

export async function fetchLatestPull(): Promise<Pull | null> {
  const data = await getJson<{ pull: Pull | null }>('/pulls/latest');
  return data.pull;
}

export async function startPull(): Promise<{ pullId: string }> {
  const response = await fetch(`${API_BASE}/pulls`, { method: 'POST' });
  const body = (await response.json().catch(() => ({}))) as {
    pullId?: string;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(body.error ?? `POST /pulls failed with ${response.status}`);
  }
  return { pullId: body.pullId ?? '' };
}

export interface Trade {
  trade_id: string;
  client: string;
  symbol: string;
  quantity: number;
  price: number;
  traded_at: string;
}

export type PullStatus = 'running' | 'completed' | 'failed' | 'interrupted' | string;

export interface Pull {
  id: string;
  status: PullStatus;
  startedAt: string;
  finishedAt: string | null;
  windowFrom: string | null;
  windowTo: string | null;
  cursorTs: string | null;
  cursorId: string | null;
  rowsIngested: number;
  rowsInserted: number;
  rowsExpected: number | null;
  windowsTotal: number | null;
  windowsDone: number;
  error: string | null;
}

export interface Stats {
  totalTrades: number;
  symbolCount: number;
  minTradedAt: string | null;
  maxTradedAt: string | null;
  latestPull: Pull | null;
}

export interface Progress {
  ingested: number;
  inserted: number;
  rowsExpected: number | null;
  windowsDone: number;
  windowsTotal: number | null;
}

export type ConnectionState = 'connecting' | 'live' | 'reconnecting';

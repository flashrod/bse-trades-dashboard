/**
 * Deterministic in-memory trade tape that stands in for BSE.
 *
 * The tape is sorted ascending by (traded_at, trade_id) so window + cursor
 * pagination is exact and repeatable. A pull is expected to take ~15 minutes,
 * which is modelled as throughput (msPerRow) rather than one long response.
 */

export interface MockTrade {
  trade_id: string;
  client: string;
  symbol: string;
  quantity: number;
  price: number;
  traded_at: number;
}

export interface MockOptions {
  seedCount: number;
  msPerRow: number;
  maxResponseMs: number;
  failRate: number;
}

const SYMBOLS: Array<{ symbol: string; base: number }> = [
  { symbol: 'RELIANCE', base: 2940 },
  { symbol: 'TCS', base: 3870 },
  { symbol: 'HDFCBANK', base: 1685 },
  { symbol: 'INFY', base: 1520 },
  { symbol: 'ICICIBANK', base: 1128 },
  { symbol: 'SBIN', base: 812 },
  { symbol: 'BHARTIARTL', base: 1462 },
  { symbol: 'ITC', base: 438 },
  { symbol: 'LT', base: 3610 },
  { symbol: 'KOTAKBANK', base: 1795 },
  { symbol: 'AXISBANK', base: 1152 },
  { symbol: 'HINDUNILVR', base: 2465 },
  { symbol: 'MARUTI', base: 12480 },
  { symbol: 'BAJFINANCE', base: 7120 },
  { symbol: 'ASIANPAINT', base: 2885 },
  { symbol: 'TITAN', base: 3390 },
  { symbol: 'SUNPHARMA', base: 1655 },
  { symbol: 'WIPRO', base: 512 },
  { symbol: 'TATAMOTORS', base: 968 },
  { symbol: 'TATASTEEL', base: 152 },
  { symbol: 'ADANIENT', base: 2985 },
  { symbol: 'ADANIPORTS', base: 1420 },
  { symbol: 'POWERGRID', base: 328 },
  { symbol: 'NTPC', base: 412 },
  { symbol: 'ONGC', base: 268 },
  { symbol: 'COALINDIA', base: 486 },
  { symbol: 'HCLTECH', base: 1742 },
  { symbol: 'ULTRACEMCO', base: 11240 },
  { symbol: 'NESTLEIND', base: 2510 },
  { symbol: 'TECHM', base: 1668 },
  { symbol: 'GRASIM', base: 2680 },
  { symbol: 'CIPLA', base: 1512 }
];

const CLIENTS: string[] = [
  'Aarav Mehta', 'Priya Nair', 'Rohan Desai', 'Ishita Rao', 'Kabir Shah',
  'Ananya Iyer', 'Vikram Sethi', 'Meera Joshi', 'Arjun Patel', 'Sneha Kulkarni',
  'Girik Capital', 'Meridian AMC', 'Northbridge FII', 'Sundaram PMS', 'Alchemy Traders',
  'Apex Securities', 'Blue Harbour Fund', 'Crestline Investments', 'Dvara Family Office', 'Eastwind Capital',
  'Fairview Advisors', 'Ganesh Traders', 'Helix Partners', 'Indus Asset Co', 'Jupiter Prop Desk',
  'Kestrel Holdings', 'Lotus Wealth', 'Mount Everest Fund', 'Nimbus Trading', 'Orion Securities',
  'Pinnacle Broking', 'Quantum Capital', 'Riverside PMS', 'Sovereign FII', 'Trellis Advisors',
  'Umbra Investments', 'Vantage Partners', 'Westbridge Fund', 'Yamuna Traders', 'Zenith Capital'
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function encodeCursor(trade: MockTrade): string {
  return Buffer.from(`${trade.traded_at}:${trade.trade_id}`).toString('base64url');
}

export function decodeCursor(value: string): { ts: number; id: string } | null {
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx === -1) return null;
    const ts = Number(decoded.slice(0, idx));
    const id = decoded.slice(idx + 1);
    if (!Number.isFinite(ts) || !id) return null;
    return { ts, id };
  } catch {
    return null;
  }
}

export class MockStore {
  trades: MockTrade[] = [];
  /** Test/demo hook: fail this many upcoming /getTrades calls with a 503. */
  failNext = 0;

  private seq = 0;
  private rnd: () => number = mulberry32(0xb5e);

  constructor(readonly options: MockOptions) {
    this.reset();
  }

  reset(): void {
    this.trades = [];
    this.seq = 0;
    this.rnd = mulberry32(0xb5e);

    // Up to now minus five minutes, spread over 30 days.
    const end = Date.now() - 5 * 60_000;
    const span = 30 * 24 * 60 * 60_000;
    const count = Math.max(1, this.options.seedCount);
    const step = span / count;

    for (let i = 0; i < count; i += 1) {
      this.trades.push(this.make(Math.round(end - (count - 1 - i) * step)));
    }
    this.sort();
  }

  /** Simulates fresh market prints arriving between pulls. */
  burst(count: number): number {
    const added = Math.max(1, Math.min(5000, Math.floor(count)));
    const now = Date.now();
    for (let i = 0; i < added; i += 1) {
      this.trades.push(this.make(now - Math.floor(Math.random() * 5 * 60_000)));
    }
    this.sort();
    return added;
  }

  meta(): {
    minTs: string;
    maxTs: string;
    totalTrades: number;
    tradesPerHour: number;
    msPerRow: number;
    maxResponseMs: number;
    estimatedFullPullMs: number;
    serverTime: string;
  } {
    const first = this.trades[0];
    const last = this.trades[this.trades.length - 1];
    const min = first ? first.traded_at : Date.now();
    const max = last ? last.traded_at : Date.now();
    const hours = Math.max((max - min) / 3_600_000, 1 / 60);
    return {
      minTs: new Date(min).toISOString(),
      maxTs: new Date(max).toISOString(),
      totalTrades: this.trades.length,
      tradesPerHour: Number((this.trades.length / hours).toFixed(2)),
      msPerRow: this.options.msPerRow,
      maxResponseMs: this.options.maxResponseMs,
      estimatedFullPullMs: this.trades.length * this.options.msPerRow,
      serverTime: new Date().toISOString()
    };
  }

  query(params: {
    from: number;
    to: number;
    limit: number;
    cursor: { ts: number; id: string } | null;
  }): { rows: MockTrade[]; nextCursor: string | null; totalInWindow: number } {
    const { from, to, limit, cursor } = params;
    const eligible = this.trades.filter((t) => {
      if (t.traded_at < from || t.traded_at >= to) return false;
      if (!cursor) return true;
      return t.traded_at > cursor.ts || (t.traded_at === cursor.ts && t.trade_id > cursor.id);
    });

    const rows = eligible.slice(0, limit);
    const lastRow = rows[rows.length - 1];
    const nextCursor = eligible.length > limit && lastRow ? encodeCursor(lastRow) : null;
    return { rows, nextCursor, totalInWindow: eligible.length };
  }

  private make(tradedAt: number): MockTrade {
    const instrument = SYMBOLS[Math.floor(this.rnd() * SYMBOLS.length)]!;
    const client = CLIENTS[Math.floor(this.rnd() * CLIENTS.length)]!;
    const drift = 0.97 + this.rnd() * 0.06;
    const price = Math.round(instrument.base * drift * 100) / 100;
    const quantity = 1 + Math.floor(Math.pow(this.rnd(), 2) * 5000);

    this.seq += 1;
    return {
      trade_id: `BSE-${String(100_000 + this.seq)}`,
      client,
      symbol: instrument.symbol,
      quantity,
      price,
      traded_at: tradedAt
    };
  }

  private sort(): void {
    this.trades.sort((a, b) => {
      if (a.traded_at !== b.traded_at) return a.traded_at - b.traded_at;
      return a.trade_id < b.trade_id ? -1 : a.trade_id > b.trade_id ? 1 : 0;
    });
  }
}

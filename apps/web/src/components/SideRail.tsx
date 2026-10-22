import { useMemo } from 'react';
import type { Trade } from '../types';
import { formatCompact } from '../format';

interface Props {
  trades: Trade[];
  windowsTotal: number | null;
}

export function SideRail({ trades, windowsTotal }: Props) {
  const { symbols, total } = useMemo(() => {
    const bySymbol = new Map<string, number>();
    let notional = 0;
    for (const trade of trades) {
      const value = trade.quantity * trade.price;
      bySymbol.set(trade.symbol, (bySymbol.get(trade.symbol) ?? 0) + value);
      notional += value;
    }
    const top = Array.from(bySymbol.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([symbol, value]) => ({
        symbol,
        share: notional > 0 ? value / notional : 0
      }));
    return { symbols: top, total: notional };
  }, [trades]);

  const peak = symbols[0]?.share ?? 0;

  return (
    <aside
      className="hidden min-h-0 w-[272px] shrink-0 flex-col gap-3 overflow-y-auto xl:flex"
      aria-label="Tape summary"
    >
      <section className="shrink-0 rounded-xl border border-line bg-surface p-4">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="micro text-faint">Symbol flow</h2>
          <span className="num text-[10px] text-muted">₹{formatCompact(total)}</span>
        </div>
        <p className="mt-1 text-[10.5px] text-muted">Share of notional · loaded rows</p>

        <div className="mt-4 space-y-2.5">
          {symbols.length === 0 && (
            <p className="text-[11px] text-muted">Waiting for the first slice…</p>
          )}
          {symbols.map((row, index) => (
            <div key={row.symbol}>
              <div className="flex items-baseline justify-between gap-2 text-[11px]">
                <span className="truncate text-ink-soft">{row.symbol}</span>
                <span className="num text-muted">{Math.round(row.share * 100)}%</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-canvas">
                <div
                  className="h-full rounded-full bg-ink"
                  style={{
                    width: `${Math.max(3, peak > 0 ? (row.share / peak) * 100 : 0)}%`,
                    opacity: Math.max(0.28, 1 - index * 0.13)
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="shrink-0 rounded-xl border border-line bg-surface p-4">
        <h2 className="micro text-faint">Pull anatomy</h2>
        <dl className="mt-3 space-y-2.5 text-[11px]">
          <Fact label="Windows" value={windowsTotal ? `${windowsTotal} × 12h` : '12h each'} />
          <Fact label="Page size" value="≤ 80 rows" />
          <Fact label="Socket cap" value="30s" />
          <Fact label="Commit" value="rows + cursor" />
        </dl>
        <p className="mt-3 border-t border-line pt-3 text-[10.5px] leading-relaxed text-muted">
          ~15 min end-to-end at 180ms/row. Nothing polls: committed slices are pushed over SSE.
        </p>
      </section>
    </aside>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className="num text-ink-soft">{value}</dd>
    </div>
  );
}

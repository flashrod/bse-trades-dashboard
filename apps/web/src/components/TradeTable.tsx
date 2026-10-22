import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Trade } from '../types';
import { formatIST, formatISTTime, formatPrice, formatQty } from '../format';
import { IconTape } from './Icons';

// Column sets change structurally per breakpoint (hidden cells leave the grid),
// so each template matches exactly the cells visible at that width.
const GRID =
  'grid items-center gap-3 ' +
  'grid-cols-[74px_minmax(0,1fr)_94px] ' +
  'sm:grid-cols-[92px_120px_64px_96px_108px] ' +
  'md:grid-cols-[104px_136px_108px_64px_96px_112px] ' +
  'lg:grid-cols-[108px_140px_108px_minmax(120px,1fr)_72px_100px_112px]';

interface Props {
  rows: Trade[];
  newIds: Set<string>;
  loading: boolean;
  total: number;
  filtered: boolean;
}

export function TradeTable({ rows, newIds, loading, total, filtered }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 44,
    overscan: 16
  });

  return (
    <div
      role="table"
      aria-label="Trade tape"
      aria-rowcount={rows.length}
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface"
    >
      <div
        role="row"
        className={`${GRID} shrink-0 border-b border-line bg-surface-2 px-5 py-2.5 text-muted`}
      >
        <span role="columnheader" className="micro hidden md:block">
          Trade ID
        </span>
        <span role="columnheader" className="micro">
          Time · IST
        </span>
        <span role="columnheader" className="micro">
          Symbol
        </span>
        <span role="columnheader" className="micro hidden lg:block">
          Client
        </span>
        <span role="columnheader" className="micro hidden text-right sm:block">
          Qty
        </span>
        <span role="columnheader" className="micro text-right">
          Price
        </span>
        <span role="columnheader" className="micro hidden text-right sm:block">
          Notional
        </span>
      </div>

      <div
        ref={scrollRef}
        role="rowgroup"
        tabIndex={0}
        aria-label="Scrollable trade rows"
        className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto [overflow-anchor:none] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/15 focus-visible:ring-inset"
      >
        {loading && rows.length === 0 ? (
          <TableSkeleton />
        ) : rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 px-6 py-8 text-center">
            <div className="relative h-14 w-16">
              <div className="absolute top-1 right-0 h-9 w-9 rounded-md bg-pale-green" />
              <svg
                viewBox="0 0 64 56"
                aria-hidden="true"
                className="relative text-line-strong"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.2}
                strokeLinecap="round"
              >
                <rect x="3.5" y="8.5" width="42" height="34" rx="2.5" fill="#ffffff" />
                <path d="M10.5 18.5h28M10.5 25.5h28M10.5 32.5h17" />
              </svg>
            </div>
            <div>
              <p className="font-serif text-[19px] leading-snug tracking-[-0.01em] text-ink">
                {filtered ? 'Nothing matches those filters.' : 'The tape is still empty.'}
              </p>
              <p className="mx-auto mt-1.5 max-w-xs text-[11.5px] leading-relaxed text-muted">
                {filtered
                  ? 'Widen the symbol, client or search field to bring rows back.'
                  : 'Start a pull. Rows commit slice by slice and stream into this ledger — no refresh, no polling.'}
              </p>
            </div>
          </div>
        ) : (
          <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const trade = rows[item.index]!;
              const isNew = newIds.has(trade.trade_id);
              return (
                <div
                  key={trade.trade_id}
                  role="row"
                  aria-rowindex={item.index + 2}
                  className={`${GRID} ${isNew ? 'row-flash' : ''} absolute top-0 left-0 w-full border-b border-line/70 px-5 text-[12.5px] transition-colors duration-150 hover:bg-canvas`}
                  style={{ height: `${item.size}px`, transform: `translateY(${item.start}px)` }}
                >
                  <span
                    role="cell"
                    title={trade.trade_id}
                    className="num hidden truncate text-[10.5px] text-muted md:block"
                  >
                    {trade.trade_id}
                  </span>
                  <span role="cell" className="num text-[11px] text-muted">
                    <span className="sm:hidden">{formatISTTime(trade.traded_at)}</span>
                    <span className="hidden sm:inline">{formatIST(trade.traded_at)}</span>
                  </span>
                  <span
                    role="cell"
                    title={trade.symbol}
                    className="truncate text-[12px] font-medium tracking-[0.01em] text-ink"
                  >
                    {trade.symbol}
                  </span>
                  <span
                    role="cell"
                    title={trade.client}
                    className="hidden truncate text-[11.5px] text-ink-soft lg:block"
                  >
                    {trade.client}
                  </span>
                  <span role="cell" className="num hidden text-right text-[11.5px] text-muted sm:block">
                    {formatQty(trade.quantity)}
                  </span>
                  <span role="cell" className="num text-right text-[12px] text-ink">
                    {formatPrice(trade.price)}
                  </span>
                  <span role="cell" className="num hidden text-right text-[11px] text-muted sm:block">
                    ₹{formatQty(Math.round(trade.quantity * trade.price))}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-line bg-surface-2 px-5 py-2.5">
        <p className="num text-[10px] tracking-[0.06em] text-muted uppercase">
          Showing <span className="text-ink">{formatQty(rows.length)}</span>
          {filtered ? ` of ${formatQty(total)}` : ''} rows
          {filtered ? ' · filtered' : ''}
        </p>
        <p className="micro hidden text-faint sm:block">Virtualized · keyset paginated · IST</p>
      </div>
    </div>
  );
}

function TableSkeleton() {
  return (
    <div aria-hidden="true" className="skeleton divide-y divide-line/70">
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className="flex h-11 items-center gap-6 px-5">
          <div className="hidden h-2 w-20 rounded bg-line md:block" />
          <div className="h-2 w-24 rounded bg-line" />
          <div className="h-2 w-16 rounded bg-line" />
          <div className="ml-auto h-2 w-14 rounded bg-line" />
          <div className="hidden h-2 w-20 rounded bg-canvas sm:block" />
        </div>
      ))}
    </div>
  );
}

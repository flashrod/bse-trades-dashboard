/**
 * Idempotent schema bootstrap. Small enough that a migration runner would be
 * ceremony; every statement is safe to re-run on boot.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pulls (
  id            text PRIMARY KEY,
  status        text NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  window_from   timestamptz,
  window_to     timestamptz,
  cursor_ts     timestamptz,
  cursor_id     text,
  rows_ingested integer NOT NULL DEFAULT 0,
  rows_inserted integer NOT NULL DEFAULT 0,
  rows_expected integer,
  windows_total integer,
  windows_done  integer NOT NULL DEFAULT 0,
  error         text
);

-- Single-flight at the database level: at most one running pull, ever.
CREATE UNIQUE INDEX IF NOT EXISTS pulls_one_running
  ON pulls (status) WHERE status = 'running';

CREATE INDEX IF NOT EXISTS pulls_started_idx ON pulls (started_at DESC);

CREATE TABLE IF NOT EXISTS trades (
  trade_id      text PRIMARY KEY,
  client        text NOT NULL,
  symbol        text NOT NULL,
  quantity      integer NOT NULL,
  price         numeric(18,4) NOT NULL,
  traded_at     timestamptz NOT NULL,
  first_pull_id text,
  last_pull_id  text,
  ingested_at   timestamptz NOT NULL DEFAULT now()
);

-- Keyset pagination for the dashboard: newest first, tie-broken by id.
CREATE INDEX IF NOT EXISTS trades_keyset_idx ON trades (traded_at DESC, trade_id DESC);
CREATE INDEX IF NOT EXISTS trades_symbol_idx ON trades (symbol);

CREATE TABLE IF NOT EXISTS events (
  id         bigserial PRIMARY KEY,
  type       text NOT NULL,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_created_idx ON events (created_at);
`;

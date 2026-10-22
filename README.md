# BSE Trade Tape

A live trades dashboard over a deliberately slow "BSE" API. A full pull takes **~15 minutes**, the network **kills any HTTP connection after 30 seconds**, and the dashboard must still open instantly and update itself with **no refresh, no polling loop, no cron**.

```
apps/mock-bse   fake BSE  :4001   GET /getTrades, seeded 5k trades, ~180ms/row, kills sockets >30s
apps/api        our API   :4000   chunked resumable puller, Postgres, SSE
apps/web        dashboard :5173   React + Vite, snapshot first paint, live merge
```

**Real 15-minute run:** [docs/real-run.md](./docs/real-run.md)

Everything runs locally: no hosted demo, no external services beyond Docker.

---

## Quick start

Prerequisites: Node 20+ (tested on 22/26), Docker.

```bash
cp .env.example .env      # points at Postgres on localhost:5433
npm install
npm run db:up             # Postgres 16 in Docker, host port 5433
npm run dev               # mock :4001, api :4000, web :5173
```

Open http://localhost:5173. On the first boot the API starts **one** pull automatically if the `trades` table is empty, so a fresh clone has data without a click. The button starts every subsequent pull (or the first one, if you set `AUTO_START_PULL=false`).

The API migrates its own schema on boot, so there is no separate setup step. While the first pull is running, the dashboard is already usable: it paints whatever has been committed and appends the rest live.

### Fast demo mode

The real pull takes ~15 minutes. To exercise the same path in ~11 seconds:

```bash
MOCK_MS_PER_ROW=2 npm run dev
```

The mock keeps its 15-minute throughput model consistent: at `180ms/row`, a page of 80 rows takes ~14.4s, comfortably under the 30s cap. At `2ms/row` the whole tape lands in ~11s but still traverses **all 60 windows and 120 pages**.

---

## What you can verify in two minutes

1. **Instant open mid-pull** — start a pull, refresh a second tab. It paints from Postgres immediately while the pull is still running.
2. **Live updates without refresh** — keep two tabs open; rows and progress appear in both as slices commit.
3. **Resume, not restart** — inject upstream failures, watch the pull fail, press Start pull again, watch it continue from the last committed cursor:
   ```bash
   curl -X POST 'localhost:4001/__admin/fail-next?count=3'
   ```
4. **No duplicates** — `curl localhost:4000/stats`, then pull again. A re-pull inserts `0` new rows.
5. **New trades across pulls** — add fresh prints, then pull again:
   ```bash
   curl -X POST 'localhost:4001/__admin/burst?count=250'
   ```

---

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/trades?limit&cursorTs&cursorId` | Newest-first keyset page |
| `GET` | `/stats` | Stored totals + latest pull |
| `GET` | `/pulls/latest` | Current/last run with cursor and counters |
| `POST` | `/pulls` | Start (or resume) a pull · `409` if one is running |
| `GET` | `/events` | SSE stream, replays after `Last-Event-ID` |
| `GET` | `/health` | API, DB and mock reachability |

Mock: `GET /getTrades?from&to&limit&cursor`, `GET /meta`, `POST /__admin/burst`, `POST /__admin/fail-next`, `POST /__admin/reset`.

SSE events: `pull.started`, `slice.committed` (carries the rows), `progress`, `pull.completed`, `pull.failed`.

---

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `postgres://bse:bse@localhost:5433/bse` | Postgres |
| `MOCK_URL` | `http://localhost:4001` | Upstream base URL |
| `FRONTEND_ORIGINS` | `http://localhost:5173` | Comma-separated CORS allowlist (`*` allowed) |
| `PULL_SLICE_HOURS` | `12` | Window size; 30 days / 12h ≈ 60 windows |
| `PULL_PAGE_LIMIT` | `80` | Rows per request; keeps each call under 30s |
| `PULL_REQUEST_TIMEOUT_MS` | `20000` | Abort before the socket cap fires |
| `PULL_MAX_ATTEMPTS` | `3` | Attempts per page before the run fails |
| `PULL_WINDOW_OVERLAP_MS` | `5000` | Re-scan margin for out-of-order arrivals |
| `AUTO_START_PULL` | `true` | One pull at boot, only if the tape is empty |
| `MOCK_MS_PER_ROW` | `180` | Simulated upstream throughput |
| `MOCK_MAX_RESPONSE_MS` | `30000` | Socket cap enforced by the mock |
| `MOCK_SEED_COUNT` | `5000` | Seeded trades |

No scheduler process exists. Pulls start from the button (`POST /pulls`) or, once, from the empty-tape bootstrap above. Restarting the API never re-triggers a pull.

---

## Tests

```bash
npm run db:up
npm test
```

Runs against `bse_test` (created by `infra/initdb/01-test-db.sql`) and covers:

- window planning: gap-free, non-overlapping, empty range;
- full ingest with the correct window count;
- idempotent re-ingest: 480 rows replayed, `0` inserted;
- failure + resume: retries exhausted, pull marked failed, next pull completes with no lost or duplicated rows;
- the 30s cap is genuinely enforced: oversized pages are killed and the pull fails cleanly.

```bash
npm run typecheck
npm run build
```

---

## Deployment notes (optional)

The brief asked for a repo and a walkthrough, not a hosted demo, so nothing is deployed. The services are deployment-shaped if you want to run them elsewhere:

- **Backend** — `npm run build`, then run `node apps/mock-bse/dist/index.js` and `node apps/api/dist/index.js` as ordinary Node services. Give each a `PORT`, and the API a `DATABASE_URL` and `MOCK_URL`.
- **Postgres** — any managed instance works; the API migrates its own schema on boot.
- **Frontend** — build with `VITE_API_URL=https://<api-host>` and serve `apps/web/dist` from any static host. Set `FRONTEND_ORIGINS` on the API to that host.

Keep the browser talking to the API directly. SSE is one long-lived request, so no serverless timeout applies to the 15-minute pull; if you put the API behind a proxy, disable response buffering for `/events`.

The mock is a real HTTP service even locally, not an in-process fixture: the API pulls from `localhost:4001` over the network, including the 30-second socket kill.

## Architecture

The pull is a durable, single-flight job that walks 12-hour windows over the tape, fetching ≤80 rows per request, and commits **rows + cursor in one transaction** per page. A killed socket or a 502 simply retries that page; a dead process resumes from `max(traded_at)` next time; `trade_id` is the primary key, so replays are idempotent. The dashboard reads the database snapshot first and then consumes an SSE stream; every event is persisted before fan-out, so a reconnect replays what was missed via `Last-Event-ID` instead of polling. The full reasoning, failure matrix and rejected alternatives follow.

### The constraint, and why it dictates the design

A full pull takes 15 minutes. The network kills any connection at 30 seconds. That means:

- **One request is impossible.** No amount of retrying fixes a response that can never finish.
- **A few large slices are also impossible.** 900s ÷ 30s = 30, so you need *more than* 30 slices. At 30 slices every request dies exactly at the cap.
- **A cursor that lives in memory is a data-loss bug.** A process restart or a reload must not replay from zero.

Chosen geometry:

| Quantity | Value |
|---|---|
| Tape span | 30 days |
| Window | 12 hours → **60 windows** |
| Rows per window | ~83 |
| Page size | 80 rows → 120 requests total |
| Upstream throughput | 180 ms/row → ~14.4s per 80-row page |
| Full pull | ~15 minutes, longest single request ~14.4s |

The 15 minutes is **emergent from the mock's throughput**, not a `sleep(900_000)` somewhere. Nothing in the system "waits 15 minutes"; it walks the tape and the elapsed time falls out of the upstream model.

### Components

```mermaid
flowchart LR
  B[Browser<br/>React + SSE] -->|GET /trades<br/>GET /pulls/latest| A[API :4000]
  A -->|SSE /events| B
  A -->|GET /getTrades<br/>from,to,limit,cursor| M[Mock BSE :4001]
  M -->|socket destroyed >30s| A
  A -->|upsert rows + cursor<br/>in one transaction| P[(Postgres)]
  A -->|read snapshot| P
```

```mermaid
sequenceDiagram
  participant UI as Dashboard
  participant API
  participant DB as Postgres
  participant M as Mock BSE

  UI->>API: GET /trades?limit=1000
  API->>DB: keyset query
  DB-->>API: rows
  API-->>UI: first paint (<300ms)

  UI->>API: POST /pulls
  API->>DB: INSERT pulls (running) — partial unique index
  API-->>UI: 202 + pullId
  API->>DB: INSERT event pull.started
  API-->>UI: SSE pull.started

  loop 60 windows
    loop pages until nextCursor = null
      API->>M: GET /getTrades?from&to&limit=80&cursor
      M-->>API: 80 rows (~14.4s)
      API->>DB: BEGIN; upsert rows; cursor := last(ts,id); COMMIT
      API->>DB: INSERT event slice.committed(rows)
      API-->>UI: SSE slice.committed(rows)
    end
    API->>DB: windows_done += 1
    API-->>UI: SSE progress
  end

  API->>DB: status = completed
  API-->>UI: SSE pull.completed
```

### Data model

```sql
pulls(id pk, status, started_at, finished_at,
      window_from, window_to, cursor_ts, cursor_id,
      rows_ingested, rows_inserted, rows_expected,
      windows_total, windows_done, error)

trades(trade_id pk, client, symbol, quantity,
       price numeric(18,4), traded_at timestamptz,
       first_pull_id, last_pull_id, ingested_at)

events(id bigserial pk, type, payload jsonb, created_at)
```

- `pulls(status) WHERE status='running'` is a **partial unique index**: the database, not application code, guarantees at most one running pull. A second `POST /pulls` gets `409`.
- `trades` uses `trade_id` as the primary key, which is what makes replays idempotent.
- `(traded_at DESC, trade_id DESC)` supports keyset pagination without `OFFSET` drift.
- `events` is the durable side of SSE. Events are inserted before they are fanned out, so replay does not depend on a process-local buffer.

### Commit protocol

Each page does one transaction:

```sql
BEGIN;
  INSERT INTO trades (...) VALUES (...)
  ON CONFLICT (trade_id) DO UPDATE SET last_pull_id = EXCLUDED.last_pull_id;

  UPDATE pulls
     SET rows_ingested = rows_ingested + n,
         cursor_ts = $last_ts,
         cursor_id = $last_id,
         windows_done = $window
   WHERE id = $pull;
COMMIT;
```

The cursor can never point past rows that are not committed. That single property gives:

| Failure | Behaviour |
|---|---|
| Socket killed at 30s | Fetch rejects → same page retried (3 attempts, backoff) |
| Upstream 503 | Same retry path |
| Retries exhausted | Run marked `failed`, cursor stays at the last committed page |
| API process dies | On boot, `running` → `interrupted`; a new pull resumes from `max(traded_at) − 5s` |
| Browser sleeps / wifi drops | `EventSource` reconnects; API replays events after `Last-Event-ID` |
| Duplicate delivery | `ON CONFLICT` makes it a no-op; `rows_inserted` proves it |
| Row arrives twice at a window boundary | 5s overlap + primary key absorb it |

"Resume" is not a separate code path: **pressing Start pull again is the resume**, because the new run starts from the durable watermark. This is deliberate — fewer states, fewer bugs.

### What starts a pull

There are exactly two triggers, and both are events, not timers:

1. The button in the header (`POST /pulls`).
2. A single check at boot: if `AUTO_START_PULL` is on **and** `trades` is empty, start one run. That check is what keeps it a one-shot seed — once the tape has rows, every later restart does nothing.

No interval, no queue poller, no scheduler.

### Why SSE and not WebSockets

- Traffic is strictly server → browser. WebSockets add a handshake, heartbeats, and reconnect logic for no gain.
- `EventSource` reconnects automatically and retransmits `Last-Event-ID`, which is exactly the resume semantic required here.
- SSE is plain HTTP: it traverses the same proxies and CORS rules as the REST calls.

A reconnect is **not** a polling loop: the client makes zero requests while connected, reconnects only on a transport failure, and the server does the catch-up by replaying persisted events. There is no `setInterval(fetch)`, no cron, and no scheduler anywhere in the repo. (The one `setInterval` in the browser is a clock that renders elapsed seconds; it makes no network calls. The one on the server writes an SSE heartbeat comment so proxies do not idle the stream out.)

### First paint vs pull completion

The dashboard never waits for a pull:

1. `GET /trades?limit=1000` + `GET /pulls/latest` render immediately from Postgres.
2. Remaining pages are backfilled with keyset pagination (bounded at 20 pages).
3. `GET /events` opens, and committed slices merge into a `Map` keyed by `trade_id`.

Rows are rendered from that map, so SSE replays and REST backfill cannot produce duplicates. New rows flash for 3.2s; the session counter persists independently of the flash.

### Boundaries and pagination

- Windows are half-open: `[from, to)`. The pull end is `maxTs + 1ms`, otherwise the newest trade is excluded by `< to`. This exact off-by-one was caught by the integration test.
- Within a window, the mock returns `nextCursor` (base64 of `traded_at:trade_id`) when more rows remain. The cursor is opaque to the client.
- The dashboard uses a separate keyset cursor `(traded_at, trade_id)` — not `OFFSET`, which silently skips rows when new trades arrive.

### Scaling (what would change for production)

- **Worker split:** move `runPull` into a separate process/queue. The partial unique index already makes that safe; the API would only enqueue and stream.
- **Fan-out:** the in-process hub is sufficient for one API instance. Multiple instances would need Postgres `LISTEN/NOTIFY` or Redis pub/sub; the durable `events` table already provides replay.
- **Retention:** `events` is pruned to 2 days at boot. Trades are retained indefinitely; partition by `traded_at` when the tape grows.
- **Backpressure:** page size is the throttle. A slower upstream means smaller pages, never a longer connection.

### Rejected alternatives

| Option | Why not |
|---|---|
| One 15-minute request | Killed at 30s by definition |
| `setInterval` client polling | Explicitly forbidden, and scales badly |
| Cron / node-cron | Explicitly forbidden; also hides the trigger |
| Poll the run status from the UI | The brief forbids polling; SSE is push |
| Offset pagination | Drifts when new rows are inserted mid-pull |
| Cursor held in memory | Lost on restart → duplicates or gaps |
| `ON CONFLICT DO NOTHING` + separate update | Two statements, worse failure window |
| Storing events only in memory | Reconnect after an API restart would lose the catch-up |

### Assumptions

- The mock is the source of truth for the upstream contract (there is no real BSE access in this exercise).
- A trade ID is globally unique. If BSE only guarantees uniqueness per symbol/day, the key becomes `(symbol, trade_id)` and the upsert changes in one place.
- Single-tenant demo: no auth, no per-user runs.
- IST for display; `timestamptz` in storage.

## Limitations

- No auth or tenancy: anyone who can reach the API can start a pull and read trades. Acceptable for this assessment; noted rather than hidden.
- A single API process owns the pull loop. The database enforces single-flight, but horizontal scaling would need the worker split into a separate service (see Scaling above).
- Mock admin endpoints (`/__admin/*`) are demo/test controls, not production surface.
- The dashboard loads up to 20k rows into memory for client-side filtering; beyond that, filtering belongs on the server.

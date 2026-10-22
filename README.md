# BSE Trade Tape

A live trades dashboard over a deliberately slow "BSE" API. A full pull takes **~15 minutes**, the network **kills any HTTP connection after 30 seconds**, and the dashboard must still open instantly and update itself with **no refresh, no polling loop, no cron**.

```
apps/mock-bse   fake BSE  :4001   GET /getTrades, seeded 5k trades, ~180ms/row, kills sockets >30s
apps/api        our API   :4000   chunked resumable puller, Postgres, SSE
apps/web        dashboard :5173   React + Vite, snapshot first paint, live merge
```

**Architecture:** [ARCHITECTURE.md](./ARCHITECTURE.md) · **Real 15-minute run:** [docs/real-run.md](./docs/real-run.md)

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

## Design in one paragraph

The pull is a durable, single-flight job that walks 12-hour windows over the tape, fetching ≤80 rows per request, and commits **rows + cursor in one transaction** per page. A killed socket or a 502 simply retries that page; a dead process resumes from `max(traded_at)` next time; `trade_id` is the primary key, so replays are idempotent. The dashboard reads the database snapshot first and then consumes an SSE stream; every event is persisted before fan-out, so a reconnect replays what was missed via `Last-Event-ID` instead of polling. Full reasoning and rejected alternatives: [ARCHITECTURE.md](./ARCHITECTURE.md).

## Limitations

- No auth or tenancy: anyone who can reach the API can start a pull and read trades. Acceptable for this assessment; noted rather than hidden.
- A single API process owns the pull loop. The database enforces single-flight, but horizontal scaling would need the worker split into a separate service (see "Scaling" in the architecture note).
- Mock admin endpoints (`/__admin/*`) are demo/test controls, not production surface.
- The dashboard loads up to 20k rows into memory for client-side filtering; beyond that, filtering belongs on the server.

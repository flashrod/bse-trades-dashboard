# Real 15-minute run

The walkthrough uses `MOCK_MS_PER_ROW=2` so the whole lifecycle fits in one take. This is the same code path at the shipped default, recorded so the 15-minute claim is not just arithmetic.

**Run:** 2026-10-22, 12:15:52 → 12:30:54 IST · **902 seconds** (15m 02s)

```
status        completed
windows       60 / 60
rows ingested 5,000
rows inserted 5,000
rows expected 5,003   (estimate: trades/hour × span, rounded)
error         none
```

The estimate is deliberately approximate; the tape holds exactly 5,000 unique trades.

## How it started

The database was truncated and the stack was booted with defaults. The pull started the moment the API finished migrating, from the empty-tape bootstrap — no button press, no manual `POST /pulls`:

```
api listening  2026-10-22T06:45:52Z
started_at     2026-10-22 06:45:52.955Z
```

That is the only automatic trigger in the system. Once `trades` had rows, restarts did nothing.

## Configuration

| Setting | Value |
|---|---|
| `MOCK_MS_PER_ROW` | `180` |
| `MOCK_MAX_RESPONSE_MS` | `30000` |
| `MOCK_SEED_COUNT` | `5000` |
| `PULL_SLICE_HOURS` | `12` |
| `PULL_PAGE_LIMIT` | `80` |

60 windows × 2 pages = 120 requests. The largest page is 80 rows × 180ms ≈ 14.4s, inside the 30s socket cap. Total: 5,000 × 180ms ≈ 900s, which is what the run took.

## Reproduce

```bash
npm run db:up
docker compose exec -T postgres psql -U bse -d bse -c "truncate trades, events, pulls;"
npm run dev        # default 180ms/row; AUTO_START_PULL=true seeds the empty tape
sleep 920
docker compose exec -T postgres psql -U bse -d bse -c \
  "select status, started_at, finished_at, windows_done, rows_ingested from pulls;"
```

The dashboard can stay open the whole time: rows and window progress arrive as slices commit.

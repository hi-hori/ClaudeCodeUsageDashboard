# D1 `rows_read` measurement

D1 bills by `rows_read`, and hitting the daily limit
(`Your D1 rows_read limit has been exceeded`) is what prompted the rollup
schema in `0002_rollup_schema.sql`. Neither the dashboard nor
`wrangler d1 execute --local` shows that number: it only comes back in the
`meta` of a query result inside a Worker.

This throwaway Worker wraps the D1 binding, runs the real `getDashboardData()`,
and adds up what every statement reported — so a query change can be checked
against actual row counts instead of guessed at.

It is not part of the deployment. Nothing here is imported by the dashboard.

## Setup

Run everything from `dashboard/`. A separate `--persist-to` directory is used
throughout so your normal local D1 in `.wrangler/` is left alone.

Real data gives the most meaningful numbers. Export the production database and
convert it with [`../migrate-v1-to-v2.mjs`](../migrate-v1-to-v2.mjs) if it still
has the pre-0002 schema:

```bash
npx wrangler d1 export claude-code-usage-dashboard --remote --output ../backup.sql
node scripts/migrate-v1-to-v2.mjs ../backup.sql --out ../v1-to-v2

npx wrangler d1 migrations apply claude-code-usage-dashboard-v2 \
  --local --persist-to ./.wrangler-verify
npx wrangler d1 execute claude-code-usage-dashboard-v2 \
  --local --persist-to ./.wrangler-verify --file ../v1-to-v2/v1-to-v2-001.sql
```

An export of a database that is already on the v2 schema can be loaded directly
with the same `d1 execute --file`.

> The export contains real usage data (including email addresses). It is
> gitignored; keep it out of commits.

## Run

```bash
npx wrangler dev --config scripts/measure/wrangler.toml \
  --persist-to ./.wrangler-verify --port 8790
```

| URL | What it does |
|-----|--------------|
| `http://127.0.0.1:8790/` | Table over a standard filter set: 1d / 7d / 30d / All, each also filtered by the busiest user and the busiest repo |
| `?days=7&user_id=1&repo=name` | One filter only |
| `?format=json` | The same numbers as JSON |

Each row shows the total `rows_read` for that dashboard load, the query count,
the elapsed time, and the per-query breakdown with the worst query in bold.

## Reading the numbers

`rows_read` counts rows *scanned*, index rows included — not rows returned. A
query that returns one row per session still bills for the whole index range it
walked, which is why the window filters are written against
`idx_sessions_day` / `idx_sessions_user_day`.

These figures come from workerd's own SQLite accounting. They track what remote
D1 charges for the same query and data closely enough to compare query shapes,
but they are not the billed value. For that, use the D1 metrics in the
Cloudflare dashboard or `wrangler d1 insights` after deploying.

## Cleanup

```bash
rm -rf .wrangler-verify
```

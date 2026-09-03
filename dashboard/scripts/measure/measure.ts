// Measure the D1 rows_read of a single dashboard load.
//
// D1 bills by rows_read, and hitting the daily limit is what prompted the
// rollup schema. Neither the dashboard nor `wrangler d1 execute --local` shows
// that number: it only comes back in the `meta` of a query result inside a
// Worker. So this Worker wraps the D1 binding, runs the real
// getDashboardData(), and adds up what each statement reported.
//
// See README.md for how to populate the local database.
//
// Usage (from dashboard/, with the local database already populated):
//
//   npx wrangler dev --config scripts/measure/wrangler.toml \
//     --persist-to ./.wrangler-verify --port 8790
//   open http://127.0.0.1:8790/            # table over a standard filter set
//   open http://127.0.0.1:8790/?days=7     # just one filter
//   curl "http://127.0.0.1:8790/?format=json"
//
// Local rows_read is workerd's own SQLite accounting, so it tracks what the
// remote D1 charges for the same query and data, but treat it as an estimate.

import { getDashboardData } from "../../app/lib/db.server";

type Env = { DB: D1Database };

type QueryStat = { rows_read: number; rows_written: number };
type Measurement =
  | {
      queries: number;
      rows_read: number;
      rows_written: number;
      per_query_rows_read: number[];
      ms: number;
      error: string | null;
    }
  | { error: string };

type Filter = { label: string; days: number; userId?: number; repo?: string };
type Row = { filter: Filter; result: Measurement };

// Statements handed to db.batch() must be the real ones, so a wrapper keeps a
// reference to what it wraps.
const RAW = Symbol("raw");

function wrapStatement(stmt: any, record: (meta: any) => void): any {
  return {
    [RAW]: stmt,
    bind: (...args: any[]) => wrapStatement(stmt.bind(...args), record),
    all: async () => {
      const r = await stmt.all();
      record(r.meta);
      return r;
    },
    run: async () => {
      const r = await stmt.run();
      record(r.meta);
      return r;
    },
    // D1's first() drops meta, so run it as all() and re-implement the shape.
    first: async (colName?: string) => {
      const r = await stmt.all();
      record(r.meta);
      const row = r.results[0] ?? null;
      if (colName != null) return row ? row[colName] : null;
      return row;
    },
    raw: async (...args: any[]) => stmt.raw(...args),
  };
}

function instrument(db: D1Database) {
  const queries: QueryStat[] = [];
  const record = (meta: any) => {
    queries.push({
      rows_read: meta?.rows_read ?? 0,
      rows_written: meta?.rows_written ?? 0,
    });
  };

  const wrapped: any = {
    prepare: (sql: string) => wrapStatement((db as any).prepare(sql), record),
    batch: async (stmts: any[]) => {
      const results = await (db as any).batch(stmts.map((s) => s[RAW] ?? s));
      for (const r of results) record(r.meta);
      return results;
    },
    exec: (sql: string) => (db as any).exec(sql),
    dump: () => (db as any).dump(),
  };

  return { db: wrapped as D1Database, queries };
}

async function measure(db: D1Database | undefined, filter: Filter): Promise<Measurement> {
  if (!db) return { error: "binding not configured" };

  const { db: wrapped, queries } = instrument(db);
  const started = Date.now();
  let error: string | null = null;
  try {
    await getDashboardData(wrapped, filter.days, filter.userId, filter.repo);
  } catch (e) {
    error = String(e);
  }

  return {
    queries: queries.length,
    rows_read: queries.reduce((sum, q) => sum + q.rows_read, 0),
    rows_written: queries.reduce((sum, q) => sum + q.rows_written, 0),
    per_query_rows_read: queries.map((q) => q.rows_read),
    ms: Date.now() - started,
    error,
  };
}

const readsOf = (m: Measurement): number | null => ("rows_read" in m ? m.rows_read : null);

/** The busiest user and repo, so the filtered rows exercise real data. Run on
 *  the raw binding: this lookup is not part of what is being measured. */
async function pickSubjects(db: D1Database): Promise<{ userId?: number; repo?: string }> {
  try {
    const user = await db
      .prepare(`SELECT user_id FROM sessions GROUP BY user_id ORDER BY COUNT(*) DESC LIMIT 1`)
      .first<{ user_id: number }>();
    const repo = await db
      .prepare(`SELECT repo_name FROM sessions GROUP BY repo_name ORDER BY COUNT(*) DESC LIMIT 1`)
      .first<{ repo_name: string }>();
    return { userId: user?.user_id, repo: repo?.repo_name };
  } catch {
    return {};
  }
}

const PERIODS = [
  { days: 1, name: "1d" },
  { days: 7, name: "7d" },
  { days: 30, name: "30d" },
  { days: 0, name: "All" },
];

async function standardFilters(env: Env): Promise<Filter[]> {
  const { userId, repo } = await pickSubjects(env.DB);
  const filters: Filter[] = [];
  for (const p of PERIODS) filters.push({ label: p.name, days: p.days });
  if (userId !== undefined) {
    for (const p of PERIODS) {
      filters.push({ label: `${p.name} + user ${userId}`, days: p.days, userId });
    }
  }
  if (repo) {
    for (const p of PERIODS) {
      filters.push({ label: `${p.name} + repo ${repo}`, days: p.days, repo });
    }
  }
  return filters;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const esc = (s: unknown) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );

const num = (n: number | null | undefined) =>
  n === null || n === undefined ? "&mdash;" : n.toLocaleString("en-US");

function cell(m: Measurement, key: "queries" | "ms" | "rows_written"): string {
  return "rows_read" in m ? num(m[key]) : "&mdash;";
}

/** Per-query rows_read, worst one in bold. */
function breakdown(m: Measurement): string {
  if (!("rows_read" in m) || m.per_query_rows_read.length === 0) return "";
  const worst = Math.max(...m.per_query_rows_read);
  return m.per_query_rows_read
    .map((n) => (n === worst && m.per_query_rows_read.length > 1 ? `<b>${num(n)}</b>` : num(n)))
    .join(" · ");
}

function renderRow(row: Row): string {
  const err = "error" in row.result && row.result.error ? row.result.error : null;
  return `
    <tr>
      <th scope="row">${esc(row.filter.label)}</th>
      <td class="n reads">${num(readsOf(row.result))}</td>
      <td class="n dim">${cell(row.result, "queries")}</td>
      <td class="n dim">${cell(row.result, "ms")}</td>
      <td class="breakdown">${breakdown(row.result)}${
        err ? `<div class="err">${esc(err)}</div>` : ""
      }</td>
    </tr>`;
}

function renderPage(rows: Row[], counts: Record<string, number | string>): string {
  const total = rows.reduce((s, r) => s + (readsOf(r.result) ?? 0), 0);
  const worst = rows.reduce<Row | null>(
    (w, r) => ((readsOf(r.result) ?? 0) > (readsOf(w?.result ?? { error: "" }) ?? 0) ? r : w),
    null
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>D1 rows_read per dashboard load</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfbfa; --fg: #1a1a19; --dim: #6b6b66; --line: #e3e3e0;
    --card: #ffffff; --reads: #2f6f9e; --hot: #b4462f; --accent: #3a5f9e;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16161a; --fg: #e8e8e6; --dim: #9a9a95; --line: #2c2c31;
      --card: #1d1d22; --reads: #7db3dd; --hot: #e08268; --accent: #8aa9dd;
    }
  }
  body {
    margin: 0; padding: 32px 24px; background: var(--bg); color: var(--fg);
    font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 820px; margin: 0 auto; }
  h1 { font-size: 19px; margin: 0 0 4px; letter-spacing: -0.01em; }
  p.sub { margin: 0 0 24px; color: var(--dim); }
  .counts { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 20px; padding: 0; list-style: none; }
  .counts li {
    background: var(--card); border: 1px solid var(--line); border-radius: 6px;
    padding: 6px 10px; font-size: 12px; color: var(--dim);
  }
  .counts b { color: var(--fg); font-variant-numeric: tabular-nums; }
  .wrap { overflow-x: auto; background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
  table { border-collapse: collapse; width: 100%; min-width: 620px; }
  caption { text-align: left; padding: 12px 14px 0; color: var(--dim); font-size: 12px; }
  th, td { padding: 8px 14px; text-align: left; border-bottom: 1px solid var(--line); }
  thead th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--dim); font-weight: 600; }
  tbody th { font-weight: 500; white-space: nowrap; }
  td.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.reads { color: var(--reads); font-weight: 600; }
  td.dim { color: var(--dim); font-size: 12px; }
  td.breakdown {
    font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
    font-size: 11px; color: var(--dim); white-space: nowrap;
  }
  td.breakdown b { color: var(--hot); }
  .err { color: var(--hot); margin-top: 4px; white-space: normal; }
  tfoot th, tfoot td { border-bottom: none; font-weight: 600; }
  footer { margin-top: 20px; color: var(--dim); font-size: 12px; }
  footer code { font-size: 11px; }
  a { color: var(--accent); }
</style>
</head>
<body>
<main>
  <h1>D1 <code>rows_read</code> per dashboard load</h1>
  <p class="sub">One load of the dashboard per row, measured on the local database.</p>

  <ul class="counts">
    ${Object.entries(counts)
      .map(([k, v]) => `<li>${esc(k)} <b>${typeof v === "number" ? num(v) : esc(v)}</b></li>`)
      .join("\n    ")}
  </ul>

  <div class="wrap">
    <table>
      <caption>Rows scanned by getDashboardData(), per filter</caption>
      <thead>
        <tr>
          <th scope="col">Filter</th>
          <th scope="col" class="n">rows_read</th>
          <th scope="col" class="n">queries</th>
          <th scope="col" class="n">ms</th>
          <th scope="col">per query</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(renderRow).join("\n")}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">Total</th>
          <td class="n reads">${num(total)}</td>
          <td class="n dim"></td>
          <td class="n dim"></td>
          <td class="dim">${
            worst ? `worst filter: ${esc(worst.filter.label)}` : ""
          }</td>
        </tr>
      </tfoot>
    </table>
  </div>

  <footer>
    <code>rows_read</code> counts rows <i>scanned</i>, index rows included &mdash;
    not rows returned. The worst query of each load is bold.
    Numbers come from workerd's own SQLite accounting, so treat them as a close
    estimate of what remote D1 bills, not the billed value itself.
    <br>Add <code>?days=7&amp;user_id=1&amp;repo=name</code> to measure a single
    filter, or <code>?format=json</code> for the raw numbers.
  </footer>
</main>
</body>
</html>`;
}

async function tableCounts(env: Env): Promise<Record<string, number | string>> {
  const count = async (table: string) => {
    try {
      const r = await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first<{ c: number }>();
      return r?.c ?? 0;
    } catch {
      return "n/a";
    }
  };
  return {
    sessions: await count("sessions"),
    tool_usage_daily: await count("tool_usage_daily"),
    session_tool_counts: await count("session_tool_counts"),
  };
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const wantsJson = url.searchParams.get("format") === "json";

    const daysParam = url.searchParams.get("days");
    const userIdParam = url.searchParams.get("user_id");
    const repoParam = url.searchParams.get("repo");
    const explicit = daysParam !== null || userIdParam !== null || repoParam !== null;

    let filters: Filter[];
    if (explicit) {
      const days = Number(daysParam ?? "7");
      const userId = userIdParam ? Number(userIdParam) : undefined;
      const repo = repoParam || undefined;
      const label = [
        days === 0 ? "All" : `${days}d`,
        userId !== undefined ? `user ${userId}` : null,
        repo ? `repo ${repo}` : null,
      ]
        .filter(Boolean)
        .join(" + ");
      filters = [{ label, days, userId, repo }];
    } else {
      filters = await standardFilters(env);
    }

    const rows: Row[] = [];
    for (const f of filters) rows.push({ filter: f, result: await measure(env.DB, f) });

    if (wantsJson) {
      return Response.json(
        rows.map((r) => ({
          filter: {
            label: r.filter.label,
            days: r.filter.days,
            user_id: r.filter.userId ?? null,
            repo: r.filter.repo ?? null,
          },
          ...r.result,
        })),
        { headers: { "cache-control": "no-store" } }
      );
    }

    return new Response(renderPage(rows, await tableCounts(env)), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  },
} satisfies ExportedHandler<Env>;

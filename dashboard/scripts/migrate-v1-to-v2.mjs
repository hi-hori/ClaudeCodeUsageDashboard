#!/usr/bin/env node
//
// Convert a v1 D1 export into SQL that fills the v2 (rollup) schema.
//
// The v1 database cannot be migrated in place: 0002_rollup_schema.sql drops and
// rebuilds every table, and the resulting schema is incompatible with the
// pre-0002 Worker. So the new deployment uses a separate database
// (claude-code-usage-dashboard-v2), and this script carries the old data over.
//
// Everything the v2 schema needs is recoverable from the v1 tables:
//
//   * v1 sessions.session_id is "<realId>#<day>" (older rows may be a plain id
//     with no "#"), which splits into the v2 primary key (session_id, day).
//     The additive columns already hold that day's increment in v1, so they
//     copy across as-is; rows that collapse onto the same (id, day) are summed.
//   * v1 rewrote a session's rows in the raw event tables on every upload
//     (DELETE then INSERT), so those tables hold the full cumulative event list
//     per session. Counting them per (day, kind, name) reproduces
//     tool_usage_daily, and per (session, day, kind, name) reproduces
//     session_tool_counts -- the same values ingest would have written.
//
// Usage:
//
//   cd dashboard
//   npx wrangler d1 export claude-code-usage-dashboard --remote --output v1.sql
//   node scripts/migrate-v1-to-v2.mjs v1.sql --out ./v1-to-v2
//   npx wrangler d1 execute claude-code-usage-dashboard-v2 --remote --file ./v1-to-v2/v1-to-v2-001.sql
//   (repeat for each generated file, in order)
//
// Run it against a v2 database that already has its migrations applied. The
// generated statements are INSERT OR REPLACE, so a partially applied run can be
// re-applied from the start without double-counting.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// Kept in sync by hand with app/lib/db.server.ts.
const SESSION_DAY_DELIM = "#";
const UNSPECIFIED_SUBAGENT = "(unspecified)";
// Events whose session is missing from v1 sessions have no project_dir to
// derive a repo from. They are rare (sessions is written first) but dropping
// them would silently lose tool usage, so they get their own bucket.
const UNKNOWN_REPO = "(unknown)";

const MAX_ROWS_PER_INSERT = 200; // SQLite caps a VALUES list at 500 rows.
const MAX_BYTES_PER_FILE = 2 * 1024 * 1024; // Keep each file small for wrangler.

/** Last path segment of a project directory. Mirrors repoNameFromProjectDir()
 *  in app/lib/db.server.ts; keep the two identical. */
function repoNameFromProjectDir(projectDir) {
  const norm = String(projectDir).replace(/\\/g, "/").replace(/\/+$/, "");
  const seg = norm.slice(norm.lastIndexOf("/") + 1);
  return seg || String(projectDir);
}

const isDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const dayOfTimestamp = (ts, fallback) =>
  typeof ts === "string" && /^\d{4}-\d{2}-\d{2}/.test(ts) ? ts.slice(0, 10) : fallback;

// Group keys hold arbitrary text (a repo directory with spaces, a skill name
// with a colon), so they are JSON-encoded rather than joined on a delimiter.
const groupKey = (...parts) => JSON.stringify(parts);

// ---------------------------------------------------------------------------
// SQL dump parsing
// ---------------------------------------------------------------------------

/** Split a dump into statements, treating ';' inside string literals as data. */
function* splitStatements(sql) {
  let start = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") i++;
          else break;
        }
        i++;
      }
      continue;
    }
    if (ch === ";") {
      const stmt = sql.slice(start, i).trim();
      if (stmt) yield stmt;
      start = i + 1;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail) yield tail;
}

/** Split on top-level commas, ignoring those inside strings or nested parens. */
function splitTopLevel(s) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") {
      i++;
      while (i < s.length) {
        if (s[i] === "'") {
          if (s[i + 1] === "'") i++;
          else break;
        }
        i++;
      }
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

const unquoteIdent = (id) => {
  const s = id.trim();
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/""/g, '"');
  if (s.startsWith("`") && s.endsWith("`")) return s.slice(1, -1).replace(/``/g, "`");
  if (s.startsWith("[") && s.endsWith("]")) return s.slice(1, -1);
  return s;
};

const IDENT = '"(?:[^"]|"")*"|`(?:[^`]|``)*`|\\[[^\\]]*\\]|[A-Za-z_][A-Za-z0-9_$]*';

/** Index of the ')' closing the '(' at `open`, skipping string literals. */
function matchParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") {
      i++;
      while (i < s.length) {
        if (s[i] === "'") {
          if (s[i + 1] === "'") i++;
          else break;
        }
        i++;
      }
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Column names of a CREATE TABLE, in declaration order, skipping table
 *  constraints and generated columns (v1 sessions has one: duration_seconds,
 *  which a dump carries no values for). */
function parseCreateTable(stmt) {
  const head = new RegExp(
    `^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})\\s*\\(`,
    "i"
  ).exec(stmt);
  if (!head) return null;
  const open = stmt.indexOf("(", head[0].length - 1);
  const close = stmt.lastIndexOf(")");
  if (open < 0 || close < open) return null;

  const columns = [];
  for (const def of splitTopLevel(stmt.slice(open + 1, close))) {
    const d = def.trim();
    if (!d) continue;
    if (/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)\b/i.test(d)) continue;
    if (/\bGENERATED\s+ALWAYS\b/i.test(d)) continue;
    const name = new RegExp(`^(${IDENT})`).exec(d);
    if (name) columns.push(unquoteIdent(name[1]));
  }
  return { table: unquoteIdent(head[1]), columns };
}

/** Parse one SQL literal: NULL, a number, or a quoted string. */
function parseValue(raw) {
  const v = raw.trim();
  if (/^NULL$/i.test(v)) return null;
  if (v.startsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v)) return Number(v);
  return v; // X'..' blobs and bare keywords: passed through untouched.
}

/** Rows of an INSERT, keyed by column name. `schema` supplies the column order
 *  when the statement has no explicit column list. */
function parseInsert(stmt, schema) {
  const head = new RegExp(`^INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO\\s+(${IDENT})\\s*`, "i").exec(stmt);
  if (!head) return null;
  const table = unquoteIdent(head[1]);

  let rest = stmt.slice(head[0].length);
  let columns = schema.get(table);
  if (rest.startsWith("(")) {
    const close = matchParen(rest, 0);
    if (close < 0) return null;
    columns = splitTopLevel(rest.slice(1, close)).map(unquoteIdent);
    rest = rest.slice(close + 1);
  }
  if (!columns) return null;

  const valuesAt = /^\s*VALUES\s*/i.exec(rest);
  if (!valuesAt) return null;
  rest = rest.slice(valuesAt[0].length);

  const rows = [];
  let i = 0;
  while (i < rest.length) {
    while (i < rest.length && /[\s,]/.test(rest[i])) i++;
    if (rest[i] !== "(") break;
    const close = matchParen(rest, i);
    if (close < 0) break;
    const values = splitTopLevel(rest.slice(i + 1, close)).map(parseValue);
    const row = {};
    columns.forEach((c, idx) => (row[c] = values[idx]));
    rows.push(row);
    i = close + 1;
  }
  return { table, rows };
}

function readDump(path) {
  const sql = readFileSync(path, "utf8");
  const schema = new Map();
  const tables = new Map();
  for (const stmt of splitStatements(sql)) {
    if (/^CREATE\s+TABLE\b/i.test(stmt)) {
      const t = parseCreateTable(stmt);
      if (t) schema.set(t.table, t.columns);
      continue;
    }
    if (/^INSERT\b/i.test(stmt)) {
      const ins = parseInsert(stmt, schema);
      if (!ins) continue;
      const bucket = tables.get(ins.table) ?? [];
      bucket.push(...ins.rows);
      tables.set(ins.table, bucket);
    }
  }
  return tables;
}

// ---------------------------------------------------------------------------
// v1 -> v2 conversion
// ---------------------------------------------------------------------------

const ADDITIVE = [
  "skill_call_count",
  "mcp_call_count",
  "subagent_call_count",
  "conversation_turns",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
];

function convertSessions(v1Rows, warn) {
  const byKey = new Map(); // (session_id, day) -> v2 sessions row
  const latestBySession = new Map(); // real id -> { last_event_at, project_dir }

  for (const r of v1Rows) {
    const raw = String(r.session_id ?? "");
    const cut = raw.indexOf(SESSION_DAY_DELIM);
    const sessionId = cut > 0 ? raw.slice(0, cut) : raw;
    const day = cut > 0 ? raw.slice(cut + 1) : dayOfTimestamp(r.last_event_at, "");

    if (!sessionId || !isDay(day)) {
      warn(`sessions: skipped row with unusable key "${raw}" (last_event_at=${r.last_event_at})`);
      continue;
    }

    const key = groupKey(sessionId, day);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        session_id: sessionId,
        day,
        user_id: r.user_id,
        project_dir: r.project_dir,
        repo_name: repoNameFromProjectDir(r.project_dir),
        git_branch: r.git_branch ?? null,
        claude_code_version: r.claude_code_version ?? null,
        model: r.model,
        first_event_at: r.first_event_at,
        last_event_at: r.last_event_at,
        ...Object.fromEntries(ADDITIVE.map((c) => [c, Number(r[c] ?? 0)])),
      });
    } else {
      // A legacy plain-id row landing on the same day as a "#day" row: the
      // additive columns are per-day increments in both, so they sum, and the
      // metadata of the later row wins.
      for (const c of ADDITIVE) existing[c] += Number(r[c] ?? 0);
      if (String(r.first_event_at) < String(existing.first_event_at)) {
        existing.first_event_at = r.first_event_at;
      }
      if (String(r.last_event_at) >= String(existing.last_event_at)) {
        existing.last_event_at = r.last_event_at;
        existing.user_id = r.user_id;
        existing.project_dir = r.project_dir;
        existing.repo_name = repoNameFromProjectDir(r.project_dir);
        existing.git_branch = r.git_branch ?? null;
        existing.claude_code_version = r.claude_code_version ?? null;
        existing.model = r.model;
      }
    }

    const seen = latestBySession.get(sessionId);
    if (!seen || String(r.last_event_at) >= String(seen.last_event_at)) {
      latestBySession.set(sessionId, {
        last_event_at: r.last_event_at,
        project_dir: r.project_dir,
      });
    }
  }

  return { rows: [...byKey.values()], latestBySession };
}

/** Count v1 event rows into the two v2 rollup tables. */
function convertEvents(v1Tables, latestBySession, warn) {
  const daily = new Map(); // key -> tool_usage_daily row
  const perSession = new Map(); // key -> session_tool_counts row
  let orphans = 0;

  const sources = [
    ["skill", "skill_usage_events", (r) => r.skill_name],
    ["mcp", "mcp_usage_events", (r) => r.mcp_server],
    ["subagent", "subagent_usage_events", (r) => r.subagent_type ?? UNSPECIFIED_SUBAGENT],
  ];

  for (const [kind, table, nameOf] of sources) {
    for (const r of v1Tables.get(table) ?? []) {
      const sessionId = String(r.session_id ?? "");
      const session = latestBySession.get(sessionId);
      if (!session) orphans++;

      // Same fallback as ingest: a malformed timestamp is credited to the
      // session's own day.
      const fallbackDay = dayOfTimestamp(session?.last_event_at, "");
      const day = dayOfTimestamp(r.timestamp, fallbackDay);
      if (!isDay(day)) {
        warn(`${table}: skipped event with no usable day (session=${sessionId})`);
        continue;
      }

      const name = String(nameOf(r) ?? UNSPECIFIED_SUBAGENT);
      const repoName = session ? repoNameFromProjectDir(session.project_dir) : UNKNOWN_REPO;
      const userId = Number(r.user_id);

      const dailyRow = daily.get(groupKey(day, userId, repoName, kind, name));
      if (dailyRow) dailyRow.call_count++;
      else {
        daily.set(groupKey(day, userId, repoName, kind, name), {
          day,
          user_id: userId,
          repo_name: repoName,
          kind,
          name,
          call_count: 1,
        });
      }

      const sessionRow = perSession.get(groupKey(sessionId, day, kind, name));
      if (sessionRow) sessionRow.call_count++;
      else {
        perSession.set(groupKey(sessionId, day, kind, name), {
          session_id: sessionId,
          day,
          kind,
          name,
          call_count: 1,
        });
      }
    }
  }

  return {
    dailyRows: [...daily.values()],
    sessionRows: [...perSession.values()],
    orphans,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const literal = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
};

function* insertStatements(table, columns, rows) {
  for (let i = 0; i < rows.length; i += MAX_ROWS_PER_INSERT) {
    const values = rows
      .slice(i, i + MAX_ROWS_PER_INSERT)
      .map((r) => `  (${columns.map((c) => literal(r[c])).join(", ")})`)
      .join(",\n");
    yield `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES\n${values};\n`;
  }
}

function writeChunks(outDir, statements) {
  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(outDir)) {
    if (/^v1-to-v2-\d+\.sql$/.test(f)) unlinkSync(join(outDir, f));
  }

  const files = [];
  let buffer = [];
  let size = 0;
  const flush = () => {
    if (!buffer.length) return;
    const name = `v1-to-v2-${String(files.length + 1).padStart(3, "0")}.sql`;
    writeFileSync(join(outDir, name), buffer.join("\n"), "utf8");
    files.push(name);
    buffer = [];
    size = 0;
  };

  for (const stmt of statements) {
    if (size > 0 && size + stmt.length > MAX_BYTES_PER_FILE) flush();
    buffer.push(stmt);
    size += stmt.length;
  }
  flush();
  return files;
}

// ---------------------------------------------------------------------------

function main(argv) {
  const args = argv.slice(2);
  const input = args.find((a) => !a.startsWith("--"));
  const outIdx = args.indexOf("--out");
  const outDir = outIdx >= 0 ? args[outIdx + 1] : "./v1-to-v2";

  if (!input) {
    console.error("Usage: node scripts/migrate-v1-to-v2.mjs <v1-export.sql> [--out <dir>]");
    process.exit(1);
  }

  const warnings = [];
  const warn = (msg) => {
    if (warnings.length < 20) console.warn(`warning: ${msg}`);
    warnings.push(msg);
  };

  const v1 = readDump(input);
  const users = v1.get("users") ?? [];
  const v1Sessions = v1.get("sessions") ?? [];
  if (!users.length && !v1Sessions.length) {
    console.error(`No users/sessions rows found in ${input}. Is it a v1 export?`);
    process.exit(1);
  }

  const { rows: sessions, latestBySession } = convertSessions(v1Sessions, warn);
  const { dailyRows, sessionRows, orphans } = convertEvents(v1, latestBySession, warn);

  const statements = [
    `-- Generated from ${input} by scripts/migrate-v1-to-v2.mjs on ${new Date().toISOString()}.\n` +
      `-- Apply to a claude-code-usage-dashboard-v2 database with its migrations already applied.\n`,
    ...insertStatements("users", ["id", "email", "created_at"], users),
    ...insertStatements(
      "sessions",
      [
        "session_id",
        "day",
        "user_id",
        "project_dir",
        "repo_name",
        "git_branch",
        "claude_code_version",
        "model",
        "first_event_at",
        "last_event_at",
        ...ADDITIVE,
      ],
      sessions
    ),
    ...insertStatements(
      "tool_usage_daily",
      ["day", "user_id", "repo_name", "kind", "name", "call_count"],
      dailyRows
    ),
    ...insertStatements(
      "session_tool_counts",
      ["session_id", "day", "kind", "name", "call_count"],
      sessionRows
    ),
  ];

  const files = writeChunks(outDir, statements);

  console.log(`Read ${input}`);
  console.log(`  users                ${users.length} -> ${users.length}`);
  console.log(`  sessions             ${v1Sessions.length} -> ${sessions.length}`);
  for (const [table, label] of [
    ["skill_usage_events", "skill events"],
    ["mcp_usage_events", "mcp events"],
    ["subagent_usage_events", "subagent events"],
  ]) {
    console.log(`  ${label.padEnd(20)} ${(v1.get(table) ?? []).length}`);
  }
  console.log(`  tool_usage_daily     -> ${dailyRows.length}`);
  console.log(`  session_tool_counts  -> ${sessionRows.length}`);
  if (orphans) {
    console.log(`  ${orphans} event(s) had no matching session; filed under "${UNKNOWN_REPO}"`);
  }
  if (warnings.length > 20) console.warn(`... and ${warnings.length - 20} more warnings`);
  console.log(`\nWrote ${files.length} file(s) to ${outDir}:`);
  for (const f of files) console.log(`  ${f}`);
}

main(process.argv);

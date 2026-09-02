-- Rebuild the schema to cut D1 rows_read.
--
-- Why: the previous schema encoded "<sessionId>#<day>" in sessions.session_id
-- and derived repo names / real ids with INSTR/SUBSTR/REPLACE expressions, so
-- almost every dashboard query was a full scan, and two correlated EXISTS
-- subqueries scanned sessions once per outer row (O(n^2)). Raw tool events were
-- also re-scanned on every dashboard load.
--
-- Now: sessions is keyed by (session_id, day) with repo_name stored, and tool
-- events are kept only as daily rollups (tool_usage_daily) plus the per-session
-- counts needed to compute increments on re-upload (session_tool_counts).
--
-- This is a breaking change: existing data is dropped, not migrated.

DROP TABLE IF EXISTS subagent_usage_events;
DROP TABLE IF EXISTS mcp_usage_events;
DROP TABLE IF EXISTS skill_usage_events;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per (session, activity day). Additive columns hold only that day's
-- increment, so SUM over a session's rows is its running total and grouping by
-- day is exact. Metadata columns reflect the latest upload; first/last_event_at
-- widen to the session's full span.
CREATE TABLE sessions (
  session_id TEXT NOT NULL,
  day TEXT NOT NULL,                 -- YYYY-MM-DD (UTC) of last_event_at at upload time
  user_id INTEGER NOT NULL REFERENCES users(id),
  project_dir TEXT NOT NULL,
  repo_name TEXT NOT NULL,           -- last path segment of project_dir, computed at ingest
  git_branch TEXT,
  claude_code_version TEXT,
  model TEXT NOT NULL,
  first_event_at TEXT NOT NULL,
  last_event_at TEXT NOT NULL,
  skill_call_count INTEGER NOT NULL DEFAULT 0,
  mcp_call_count INTEGER NOT NULL DEFAULT 0,
  subagent_call_count INTEGER NOT NULL DEFAULT 0,
  conversation_turns INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, day)
);

-- Window filters are "day >= ?"; a user filter narrows the scan further.
CREATE INDEX idx_sessions_day ON sessions(day);
CREATE INDEX idx_sessions_user_day ON sessions(user_id, day);

-- Daily rollup of tool usage (skills / MCP servers / subagents). Rows are
-- upserted additively at ingest; the dashboard never touches raw events.
CREATE TABLE tool_usage_daily (
  day TEXT NOT NULL,                 -- YYYY-MM-DD (UTC) of the event timestamp
  user_id INTEGER NOT NULL REFERENCES users(id),
  repo_name TEXT NOT NULL,
  kind TEXT NOT NULL,                -- 'skill' | 'mcp' | 'subagent'
  name TEXT NOT NULL,                -- skill_name | mcp_server | subagent_type
  call_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id, repo_name, kind, name)
);

-- Per-session counts already credited to tool_usage_daily, so a re-upload of
-- the cumulative snapshot adds only the increment. Read by PK prefix at ingest.
CREATE TABLE session_tool_counts (
  session_id TEXT NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  call_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, day, kind, name)
);

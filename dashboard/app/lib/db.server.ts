import type {
  IngestPayload,
  KpiData,
  UserRankingEntry,
  UserEntry,
  DistributionEntry,
  DailyTrendEntry,
  DailyToolUsageEntry,
  RecentSessionEntry,
  RepoEntry,
  DashboardData,
} from "./types";
import { calculateEstimatedCost } from "./cost";

export async function upsertUser(
  db: D1Database,
  email: string
): Promise<number> {
  await db
    .prepare("INSERT OR IGNORE INTO users (email) VALUES (?)")
    .bind(email)
    .run();

  const row = await db
    .prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: number }>();

  return row!.id;
}

export async function upsertSessionAndEvents(
  db: D1Database,
  userId: number,
  payload: IngestPayload
): Promise<{
  skillEventsInserted: number;
  mcpEventsInserted: number;
  subagentEventsInserted: number;
}> {
  const { session, skill_events, mcp_events, subagent_events } = payload;

  // One row per (session, day). The PK encodes the activity day so a session
  // continuing into a new day gets a fresh row instead of inflating the start
  // day. The hook re-uploads the cumulative snapshot, so we credit only the
  // increment since everything stored so far for this session — summed across
  // its existing rows (legacy plain-id row, if any, included) — to the day's
  // row. Event tables keep the REAL session id; only the sessions PK is keyed
  // by day.
  const realId = session.session_id;
  const day = session.last_event_at.slice(0, 10);
  const dayKey = `${realId}${SESSION_DAY_DELIM}${day}`;

  const prev = await db
    .prepare(
      `SELECT
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
        COALESCE(SUM(skill_call_count), 0) AS skill_call_count,
        COALESCE(SUM(mcp_call_count), 0) AS mcp_call_count,
        COALESCE(SUM(subagent_call_count), 0) AS subagent_call_count,
        COALESCE(SUM(conversation_turns), 0) AS conversation_turns
      FROM sessions
      WHERE session_id = ? OR session_id LIKE ? || '${SESSION_DAY_DELIM}%'`
    )
    .bind(realId, realId)
    .first<{
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      skill_call_count: number;
      mcp_call_count: number;
      subagent_call_count: number;
      conversation_turns: number;
    }>();

  // Clamp to >= 0: cumulative totals are monotonic for an append-only
  // transcript, but guard against a re-parse reporting a smaller total.
  const d = (now: number, before: number | undefined) => Math.max(0, now - (before ?? 0));
  const dInput = d(session.input_tokens, prev?.input_tokens);
  const dOutput = d(session.output_tokens, prev?.output_tokens);
  const dCacheRead = d(session.cache_read_tokens, prev?.cache_read_tokens);
  const dCacheCreation = d(session.cache_creation_tokens, prev?.cache_creation_tokens);
  const dSkill = d(skill_events.length, prev?.skill_call_count);
  const dMcp = d(mcp_events.length, prev?.mcp_call_count);
  const dSubagent = d(subagent_events.length, prev?.subagent_call_count);
  const dTurns = d(session.conversation_turns, prev?.conversation_turns);

  const statements: D1PreparedStatement[] = [];

  // Add this upload's deltas to the day's row (created on first sight of the
  // day). Additive columns accumulate; metadata reflects the latest upload, and
  // first/last_event_at widen to the session's full span so duration_seconds
  // (a generated column) stays meaningful per row. An identical re-fire yields
  // all-zero deltas, leaving the row unchanged.
  statements.push(
    db
      .prepare(
        `INSERT INTO sessions (
          session_id, user_id, project_dir, git_branch, claude_code_version,
          model, first_event_at, last_event_at,
          skill_call_count, mcp_call_count, subagent_call_count, conversation_turns,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          user_id = excluded.user_id,
          project_dir = excluded.project_dir,
          git_branch = excluded.git_branch,
          claude_code_version = excluded.claude_code_version,
          model = excluded.model,
          first_event_at = MIN(sessions.first_event_at, excluded.first_event_at),
          last_event_at = MAX(sessions.last_event_at, excluded.last_event_at),
          skill_call_count = sessions.skill_call_count + excluded.skill_call_count,
          mcp_call_count = sessions.mcp_call_count + excluded.mcp_call_count,
          subagent_call_count = sessions.subagent_call_count + excluded.subagent_call_count,
          conversation_turns = sessions.conversation_turns + excluded.conversation_turns,
          input_tokens = sessions.input_tokens + excluded.input_tokens,
          output_tokens = sessions.output_tokens + excluded.output_tokens,
          cache_read_tokens = sessions.cache_read_tokens + excluded.cache_read_tokens,
          cache_creation_tokens = sessions.cache_creation_tokens + excluded.cache_creation_tokens`
      )
      .bind(
        dayKey,
        userId,
        session.project_dir,
        session.git_branch ?? null,
        session.claude_code_version ?? null,
        session.model,
        session.first_event_at,
        session.last_event_at,
        dSkill,
        dMcp,
        dSubagent,
        dTurns,
        dInput,
        dOutput,
        dCacheRead,
        dCacheCreation
      )
  );

  statements.push(
    db.prepare("DELETE FROM skill_usage_events WHERE session_id = ?").bind(session.session_id)
  );
  statements.push(
    db.prepare("DELETE FROM mcp_usage_events WHERE session_id = ?").bind(session.session_id)
  );
  statements.push(
    db.prepare("DELETE FROM subagent_usage_events WHERE session_id = ?").bind(session.session_id)
  );

  // Insert skill events
  for (const event of skill_events) {
    statements.push(
      db
        .prepare(
          `INSERT INTO skill_usage_events (session_id, user_id, skill_name, timestamp)
           VALUES (?, ?, ?, ?)`
        )
        .bind(session.session_id, userId, event.skill_name, event.timestamp)
    );
  }

  // Insert MCP events
  for (const event of mcp_events) {
    statements.push(
      db
        .prepare(
          `INSERT INTO mcp_usage_events (session_id, user_id, tool_name, mcp_server, mcp_method, timestamp)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(
          session.session_id,
          userId,
          event.tool_name,
          event.mcp_server,
          event.mcp_method,
          event.timestamp
        )
    );
  }

  // Insert subagent events
  for (const event of subagent_events) {
    statements.push(
      db
        .prepare(
          `INSERT INTO subagent_usage_events (session_id, user_id, subagent_type, timestamp)
           VALUES (?, ?, ?, ?)`
        )
        .bind(
          session.session_id,
          userId,
          event.subagent_type,
          event.timestamp
        )
    );
  }

  // D1 batch: up to 1000 bound parameters. Chunk if needed.
  const CHUNK_SIZE = 100;
  for (let i = 0; i < statements.length; i += CHUNK_SIZE) {
    await db.batch(statements.slice(i, i + CHUNK_SIZE));
  }

  return {
    skillEventsInserted: skill_events.length,
    mcpEventsInserted: mcp_events.length,
    subagentEventsInserted: subagent_events.length,
  };
}

// SQL expression to extract repo name (last path segment) from a project_dir
// column expression. Normalize Windows-style backslashes to '/' first so the
// same logic works for both POSIX paths and paths captured on Windows
// (e.g. "D:\\Work\\repo").
const REPO_NAME_FROM = (colExpr: string) => {
  const norm = `REPLACE(${colExpr}, '\\', '/')`;
  return `SUBSTR(${norm}, LENGTH(RTRIM(${norm}, REPLACE(${norm}, '/', ''))) + 1)`;
};
const REPO_NAME_EXPR = (prefix: string) =>
  REPO_NAME_FROM(prefix ? `${prefix}.project_dir` : "project_dir");

// Sessions are stored one row per (session, day): the PK session_id holds
// "<realSessionId>#<YYYY-MM-DD>" and each row carries only that day's delta, so
// SUM(...) over a session's rows yields its running total and DATE grouping is
// exact. These helpers recover the real session id and the activity day from
// the composite key. They tolerate legacy rows written before this scheme
// (plain real id, no '#') — those fall back to DATE(first/last_event_at).
const SESSION_DAY_DELIM = "#";
const REAL_SESSION_ID = (col: string) =>
  `CASE WHEN INSTR(${col}, '${SESSION_DAY_DELIM}') > 0` +
  ` THEN SUBSTR(${col}, 1, INSTR(${col}, '${SESSION_DAY_DELIM}') - 1) ELSE ${col} END`;
const SESSION_DAY = (col: string, fallbackTs: string) =>
  `CASE WHEN INSTR(${col}, '${SESSION_DAY_DELIM}') > 0` +
  ` THEN SUBSTR(${col}, INSTR(${col}, '${SESSION_DAY_DELIM}') + 1) ELSE DATE(${fallbackTs}) END`;

/** Build WHERE clause and bind params for session-table queries */
function buildSessionFilter(
  hasDateFilter: boolean,
  dateFilter: string,
  userId: number | undefined,
  repo: string | undefined,
  prefix = "",
): { where: string; params: unknown[] } {
  const p = prefix ? `${prefix}.` : "";
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (hasDateFilter) {
    conditions.push(`${p}first_event_at >= datetime('now', ?)`);
    params.push(dateFilter);
  }
  if (userId !== undefined) {
    conditions.push(`${p}user_id = ?`);
    params.push(userId);
  }
  if (repo) {
    conditions.push(`REPLACE(${p}project_dir, '\\', '/') LIKE '%/' || ?`);
    params.push(repo);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return { where, params };
}

/** Build WHERE clause for event-table queries, optionally joining to sessions for repo filter */
function buildEventFilter(
  hasDateFilter: boolean,
  dateFilter: string,
  userId: number | undefined,
  repo: string | undefined,
  timestampCol: string,
  eventAlias: string,
): { join: string; where: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let join = "";
  if (hasDateFilter) {
    conditions.push(`${eventAlias}.${timestampCol} >= datetime('now', ?)`);
    params.push(dateFilter);
  }
  if (userId !== undefined) {
    conditions.push(`${eventAlias}.user_id = ?`);
    params.push(userId);
  }
  if (repo) {
    // sessions is keyed by "<realId>#<date>", so a plain equi-join on
    // session_id no longer matches the event's real id and would also fan out
    // across a session's day-rows. Match on the recovered real id via EXISTS to
    // filter without duplicating event rows.
    conditions.push(
      `EXISTS (SELECT 1 FROM sessions _fs
        WHERE ${REAL_SESSION_ID("_fs.session_id")} = ${eventAlias}.session_id
        AND REPLACE(_fs.project_dir, '\\', '/') LIKE '%/' || ?)`
    );
    params.push(repo);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return { join, where, params };
}

export async function getDashboardData(
  db: D1Database,
  days: number,
  userId?: number,
  repo?: string,
): Promise<DashboardData> {
  // days === 0 means "all time" — no date filter
  const hasDateFilter = days > 0;
  const dateFilter = `-${days} days`;

  // Pre-build common filter clauses
  const sf = buildSessionFilter(hasDateFilter, dateFilter, userId, repo);
  const sfJoin = buildSessionFilter(hasDateFilter, dateFilter, userId, repo, "s");

  // KPI aggregation. Token/turn/call SUMs are correct as-is because each
  // day-row holds a delta; only the session count must collapse a session's
  // day-rows back to one via the recovered real id.
  const kpiRaw = await db.prepare(
    `SELECT
      COUNT(DISTINCT ${REAL_SESSION_ID("session_id")}) as total_sessions,
      COALESCE(SUM(conversation_turns), 0) as total_conversation_turns,
      COALESCE(SUM(skill_call_count), 0) as total_skill_calls,
      COALESCE(SUM(mcp_call_count), 0) as total_mcp_calls,
      COALESCE(SUM(subagent_call_count), 0) as total_subagent_calls,
      COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0) as total_tokens
    FROM sessions
    ${sf.where}`
  ).bind(...sf.params).first<Omit<KpiData, "total_estimated_cost">>();

  // KPI cost: aggregate per model then compute
  type ModelTokenRow = { model: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number };
  const kpiCostResult = await db.prepare(
    `SELECT model,
      SUM(input_tokens) as input_tokens,
      SUM(output_tokens) as output_tokens,
      SUM(cache_read_tokens) as cache_read_tokens,
      SUM(cache_creation_tokens) as cache_creation_tokens
    FROM sessions
    ${sf.where}
    GROUP BY model`
  ).bind(...sf.params).all<ModelTokenRow>();
  const totalEstimatedCost = kpiCostResult.results.reduce(
    (sum, r) => sum + calculateEstimatedCost(r.model, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_creation_tokens),
    0
  );

  const kpiResult: KpiData = {
    total_sessions: kpiRaw?.total_sessions ?? 0,
    total_conversation_turns: kpiRaw?.total_conversation_turns ?? 0,
    total_skill_calls: kpiRaw?.total_skill_calls ?? 0,
    total_mcp_calls: kpiRaw?.total_mcp_calls ?? 0,
    total_subagent_calls: kpiRaw?.total_subagent_calls ?? 0,
    total_tokens: kpiRaw?.total_tokens ?? 0,
    total_estimated_cost: totalEstimatedCost,
  };

  // User ranking by cost (aggregate per user+model, then compute cost in app)
  type UserModelRow = { user_id: number; email: string; model: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number; session_count: number };
  const userRankingRaw = await db.prepare(
    `SELECT u.id as user_id, u.email, s.model,
      SUM(s.input_tokens) as input_tokens,
      SUM(s.output_tokens) as output_tokens,
      SUM(s.cache_read_tokens) as cache_read_tokens,
      SUM(s.cache_creation_tokens) as cache_creation_tokens,
      COUNT(DISTINCT ${REAL_SESSION_ID("s.session_id")}) as session_count
    FROM sessions s JOIN users u ON s.user_id = u.id
    ${sfJoin.where}
    GROUP BY s.user_id, s.model`
  ).bind(...sfJoin.params).all<UserModelRow>();

  const userMap = new Map<number, { user_id: number; email: string; total_cost: number; total_sessions: number }>();
  for (const r of userRankingRaw.results) {
    const cost = calculateEstimatedCost(r.model, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_creation_tokens);
    const existing = userMap.get(r.user_id) ?? { user_id: r.user_id, email: r.email, total_cost: 0, total_sessions: 0 };
    existing.total_cost += cost;
    existing.total_sessions += r.session_count;
    userMap.set(r.user_id, existing);
  }
  const userRanking: UserRankingEntry[] = Array.from(userMap.values())
    .sort((a, b) => b.total_cost - a.total_cost)
    .slice(0, 10);

  // Skill distribution
  const skillEf = buildEventFilter(hasDateFilter, dateFilter, userId, repo, "timestamp", "e");
  const skillDistResult = await db.prepare(
    `SELECT e.skill_name as name, COUNT(*) as count
    FROM skill_usage_events e ${skillEf.join}
    ${skillEf.where}
    GROUP BY e.skill_name
    ORDER BY count DESC`
  ).bind(...skillEf.params).all<DistributionEntry>();

  // MCP server distribution
  const mcpEf = buildEventFilter(hasDateFilter, dateFilter, userId, repo, "timestamp", "e");
  const mcpDistResult = await db.prepare(
    `SELECT e.mcp_server as name, COUNT(*) as count
    FROM mcp_usage_events e ${mcpEf.join}
    ${mcpEf.where}
    GROUP BY e.mcp_server
    ORDER BY count DESC`
  ).bind(...mcpEf.params).all<DistributionEntry>();

  // Model distribution
  const modelDistResult = await db.prepare(
    `SELECT model as name, COUNT(DISTINCT ${REAL_SESSION_ID("session_id")}) as count
    FROM sessions
    ${sf.where}
    GROUP BY model
    ORDER BY count DESC`
  ).bind(...sf.params).all<DistributionEntry>();

  // Subagent distribution
  const subEf = buildEventFilter(hasDateFilter, dateFilter, userId, repo, "timestamp", "e");
  const subagentDistResult = await db.prepare(
    `SELECT COALESCE(e.subagent_type, '(unspecified)') as name, COUNT(*) as count
    FROM subagent_usage_events e ${subEf.join}
    ${subEf.where}
    GROUP BY e.subagent_type
    ORDER BY count DESC`
  ).bind(...subEf.params).all<DistributionEntry>();

  // Daily cost/token trend (aggregate per date+model, compute cost in app).
  // Each row already holds a single day's delta keyed by that day, so grouping
  // on the day recovered from the PK attributes tokens to the day they were
  // consumed — a multi-day session is split across the days it ran instead of
  // piling onto its start day.
  type DailyModelRow = { date: string; model: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number };
  // Legacy plain-id rows (pre day-keying) keep their original start-day
  // attribution; composite rows use their embedded day.
  const trendDate = SESSION_DAY("session_id", "first_event_at");
  const trendConditions: string[] = [];
  const trendParams: unknown[] = [];
  if (hasDateFilter) {
    trendConditions.push(`${trendDate} >= date('now', ?)`);
    trendParams.push(dateFilter);
  }
  if (userId !== undefined) {
    trendConditions.push(`user_id = ?`);
    trendParams.push(userId);
  }
  if (repo) {
    trendConditions.push(`REPLACE(project_dir, '\\', '/') LIKE '%/' || ?`);
    trendParams.push(repo);
  }
  const trendWhere = trendConditions.length > 0 ? `WHERE ${trendConditions.join(" AND ")}` : "";
  const dailyTrendRaw = await db.prepare(
    `SELECT
      ${trendDate} as date,
      model,
      SUM(input_tokens) as input_tokens,
      SUM(output_tokens) as output_tokens,
      SUM(cache_read_tokens) as cache_read_tokens,
      SUM(cache_creation_tokens) as cache_creation_tokens
    FROM sessions
    ${trendWhere}
    GROUP BY ${trendDate}, model
    ORDER BY date`
  ).bind(...trendParams).all<DailyModelRow>();

  const dailyMap = new Map<string, DailyTrendEntry>();
  for (const r of dailyTrendRaw.results) {
    const cost = calculateEstimatedCost(r.model, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_creation_tokens);
    const existing = dailyMap.get(r.date) ?? { date: r.date, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, estimated_cost: 0 };
    existing.input_tokens += r.input_tokens;
    existing.output_tokens += r.output_tokens;
    existing.cache_read_tokens += r.cache_read_tokens;
    existing.cache_creation_tokens += r.cache_creation_tokens;
    existing.estimated_cost += cost;
    dailyMap.set(r.date, existing);
  }
  const dailyTrend = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  // Daily tool usage — each sub-query needs its own filter
  const skillToolEf = buildEventFilter(hasDateFilter, dateFilter, userId, repo, "timestamp", "e");
  const mcpToolEf = buildEventFilter(hasDateFilter, dateFilter, userId, repo, "timestamp", "e");
  const subToolEf = buildEventFilter(hasDateFilter, dateFilter, userId, repo, "timestamp", "e");

  const dailyToolQuery = `SELECT
      date,
      SUM(skill_count) as skill_count,
      SUM(mcp_count) as mcp_count,
      SUM(subagent_count) as subagent_count
    FROM (
      SELECT DATE(e.timestamp) as date, COUNT(*) as skill_count, 0 as mcp_count, 0 as subagent_count
      FROM skill_usage_events e ${skillToolEf.join}
      ${skillToolEf.where}
      GROUP BY DATE(e.timestamp)
      UNION ALL
      SELECT DATE(e.timestamp) as date, 0, COUNT(*), 0
      FROM mcp_usage_events e ${mcpToolEf.join}
      ${mcpToolEf.where}
      GROUP BY DATE(e.timestamp)
      UNION ALL
      SELECT DATE(e.timestamp) as date, 0, 0, COUNT(*)
      FROM subagent_usage_events e ${subToolEf.join}
      ${subToolEf.where}
      GROUP BY DATE(e.timestamp)
    )
    GROUP BY date
    ORDER BY date`;
  const dailyToolResult = await db.prepare(dailyToolQuery)
    .bind(...skillToolEf.params, ...mcpToolEf.params, ...subToolEf.params)
    .all<DailyToolUsageEntry>();

  // Recent sessions. A session now spans several day-rows, so collapse them
  // back to one entry per real session id: SUM the additive metrics, take the
  // widest span (MIN first / MAX last) and the latest metadata. duration_seconds
  // is a per-row generated column over the full span, so MAX gives the session
  // duration. A window function flags each session's most recent day-row so we
  // can also expose that day's portion (latest_* columns) alongside the totals.
  type RecentSessionRow = Omit<
    RecentSessionEntry,
    "estimated_cost_usd" | "latest_total_tokens" | "latest_estimated_cost_usd"
  > & {
    latest_input_tokens: number;
    latest_output_tokens: number;
    latest_cache_read_tokens: number;
    latest_cache_creation_tokens: number;
  };
  const rid = REAL_SESSION_ID("s.session_id");
  const sday = SESSION_DAY("s.session_id", "s.first_event_at");
  const recentSessionsRaw = await db.prepare(
    `SELECT
      rid as session_id,
      MAX(user_id) as user_id, MAX(email) as email,
      ${REPO_NAME_FROM("MAX(project_dir)")} as repo_name,
      MAX(model) as model, MAX(duration_seconds) as duration_seconds,
      SUM(conversation_turns) as conversation_turns, SUM(skill_call_count) as skill_call_count,
      SUM(mcp_call_count) as mcp_call_count, SUM(subagent_call_count) as subagent_call_count,
      SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
      SUM(cache_read_tokens) as cache_read_tokens, SUM(cache_creation_tokens) as cache_creation_tokens,
      MAX(last_event_at) as last_event_at,
      SUM(CASE WHEN is_latest = 1 THEN conversation_turns ELSE 0 END) as latest_conversation_turns,
      SUM(CASE WHEN is_latest = 1 THEN skill_call_count ELSE 0 END) as latest_skill_call_count,
      SUM(CASE WHEN is_latest = 1 THEN mcp_call_count ELSE 0 END) as latest_mcp_call_count,
      SUM(CASE WHEN is_latest = 1 THEN subagent_call_count ELSE 0 END) as latest_subagent_call_count,
      SUM(CASE WHEN is_latest = 1 THEN input_tokens ELSE 0 END) as latest_input_tokens,
      SUM(CASE WHEN is_latest = 1 THEN output_tokens ELSE 0 END) as latest_output_tokens,
      SUM(CASE WHEN is_latest = 1 THEN cache_read_tokens ELSE 0 END) as latest_cache_read_tokens,
      SUM(CASE WHEN is_latest = 1 THEN cache_creation_tokens ELSE 0 END) as latest_cache_creation_tokens
    FROM (
      SELECT
        ${rid} as rid,
        s.user_id, u.email, s.project_dir, s.model, s.duration_seconds,
        s.conversation_turns, s.skill_call_count, s.mcp_call_count, s.subagent_call_count,
        s.input_tokens, s.output_tokens, s.cache_read_tokens, s.cache_creation_tokens, s.last_event_at,
        CASE WHEN ${sday} = MAX(${sday}) OVER (PARTITION BY ${rid}) THEN 1 ELSE 0 END as is_latest
      FROM sessions s JOIN users u ON s.user_id = u.id
      ${sfJoin.where}
    )
    GROUP BY rid
    ORDER BY last_event_at DESC
    LIMIT 20`
  ).bind(...sfJoin.params).all<RecentSessionRow>();

  const recentSessions: RecentSessionEntry[] = recentSessionsRaw.results.map((r) => {
    const {
      latest_input_tokens,
      latest_output_tokens,
      latest_cache_read_tokens,
      latest_cache_creation_tokens,
      ...rest
    } = r;
    return {
      ...rest,
      estimated_cost_usd: calculateEstimatedCost(r.model, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_creation_tokens),
      latest_total_tokens:
        latest_input_tokens + latest_output_tokens + latest_cache_read_tokens + latest_cache_creation_tokens,
      latest_estimated_cost_usd: calculateEstimatedCost(
        r.model,
        latest_input_tokens,
        latest_output_tokens,
        latest_cache_read_tokens,
        latest_cache_creation_tokens
      ),
    };
  });

  // Users list (date-filtered only, no user/repo filter so the selector always shows all users)
  const dateOnlyFilter = buildSessionFilter(hasDateFilter, dateFilter, undefined, undefined);
  const dateOnlyJoinFilter = buildSessionFilter(hasDateFilter, dateFilter, undefined, undefined, "s");
  const usersResult = await db.prepare(
    `SELECT u.id as user_id, u.email, COUNT(DISTINCT ${REAL_SESSION_ID("s.session_id")}) as session_count
    FROM sessions s JOIN users u ON s.user_id = u.id
    ${dateOnlyJoinFilter.where}
    GROUP BY u.id
    ORDER BY session_count DESC`
  ).bind(...dateOnlyJoinFilter.params).all<UserEntry>();

  // Repos list (date-filtered only, no user/repo filter so the selector always shows all repos)
  const reposResult = await db.prepare(
    `SELECT
      ${REPO_NAME_EXPR("")} as repo_name,
      COUNT(DISTINCT ${REAL_SESSION_ID("session_id")}) as session_count
    FROM sessions
    ${dateOnlyFilter.where}
    GROUP BY repo_name
    ORDER BY session_count DESC`
  ).bind(...dateOnlyFilter.params).all<RepoEntry>();

  // Look up user email for filter display
  let filterUserEmail: string | undefined;
  if (userId !== undefined) {
    const userRow = await db.prepare("SELECT email FROM users WHERE id = ?").bind(userId).first<{ email: string }>();
    filterUserEmail = userRow?.email;
  }

  return {
    kpi: kpiResult,
    userRanking,
    skillDistribution: skillDistResult.results,
    mcpDistribution: mcpDistResult.results,
    modelDistribution: modelDistResult.results,
    subagentDistribution: subagentDistResult.results,
    dailyTrend,
    dailyToolUsage: dailyToolResult.results,
    recentSessions,
    users: usersResult.results,
    repos: reposResult.results,
    days,
    filterUserId: userId,
    filterUserEmail,
    filterRepo: repo,
  };
}

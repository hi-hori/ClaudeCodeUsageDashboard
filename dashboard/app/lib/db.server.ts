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

// D1 bills by rows_read (rows scanned, index rows included), so every query
// here is written to touch only the rows it needs: window filters hit an index
// on `day`, per-session reads use the (session_id, day) primary key, and tool
// events are stored pre-aggregated per day instead of as raw rows.

type ToolKind = "skill" | "mcp" | "subagent";
const UNSPECIFIED_SUBAGENT = "(unspecified)";
const RECENT_SESSIONS_LIMIT = 20;
const USER_RANKING_LIMIT = 10;

/** Last path segment of a project directory. Windows backslashes are
 *  normalized so "D:\\Work\\repo" and "/home/me/repo" both yield "repo". */
export function repoNameFromProjectDir(projectDir: string): string {
  const norm = projectDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const seg = norm.slice(norm.lastIndexOf("/") + 1);
  return seg || projectDir;
}

/** YYYY-MM-DD (UTC) of an ISO timestamp; `fallback` when it is malformed. */
function dayOf(ts: string | undefined, fallback: string): string {
  return ts && /^\d{4}-\d{2}-\d{2}/.test(ts) ? ts.slice(0, 10) : fallback;
}

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

type SessionTotalsRow = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  skill_call_count: number;
  mcp_call_count: number;
  subagent_call_count: number;
  conversation_turns: number;
  cost_usd: number;
  /** Day-rows whose cost_usd is non-NULL, i.e. whether the session has ever
   *  reported a cost. */
  cost_reported_rows: number;
};

type ToolCountRow = { day: string; kind: ToolKind; name: string; call_count: number };

const toolKey = (day: string, kind: string, name: string) => `${day}\u0000${kind}\u0000${name}`;

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

  // One sessions row per (session, day). The hook re-uploads the cumulative
  // snapshot, so we credit only the increment since everything stored so far
  // for this session to the current day's row. Both "previous" reads are
  // primary-key-prefix lookups on session_id.
  const sessionId = session.session_id;
  const day = session.last_event_at.slice(0, 10);
  const repoName = repoNameFromProjectDir(session.project_dir);

  const [prevRes, prevToolRes] = (await db.batch([
    db
      .prepare(
        `SELECT
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
          COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
          COALESCE(SUM(skill_call_count), 0) AS skill_call_count,
          COALESCE(SUM(mcp_call_count), 0) AS mcp_call_count,
          COALESCE(SUM(subagent_call_count), 0) AS subagent_call_count,
          COALESCE(SUM(conversation_turns), 0) AS conversation_turns,
          COALESCE(SUM(cost_usd), 0) AS cost_usd,
          COUNT(cost_usd) AS cost_reported_rows
        FROM sessions
        WHERE session_id = ?`
      )
      .bind(sessionId),
    db
      .prepare(
        `SELECT day, kind, name, call_count
        FROM session_tool_counts
        WHERE session_id = ?`
      )
      .bind(sessionId),
  ])) as [D1Result<SessionTotalsRow>, D1Result<ToolCountRow>];
  const prev = prevRes.results[0];

  // Clamp to >= 0: cumulative totals are monotonic for an append-only
  // transcript, but guard against a re-parse reporting a smaller total.
  const d = (now: number, before: number | undefined) => Math.max(0, now - (before ?? 0));

  const statements: D1PreparedStatement[] = [];

  const dInput = d(session.input_tokens, prev?.input_tokens);
  const dOutput = d(session.output_tokens, prev?.output_tokens);
  const dCacheRead = d(session.cache_read_tokens, prev?.cache_read_tokens);
  const dCacheCreation = d(session.cache_creation_tokens, prev?.cache_creation_tokens);

  // A reported cost is cumulative for the whole session, so once one arrives
  // every day-row must be priced from it. Rows still holding NULL (uploaded
  // before the hook reported cost, or while Claude Code tracked none) would
  // otherwise keep falling back to the pricing table and be counted twice on
  // top of the full cumulative total credited below. Zero them first — the
  // delta is measured against the same COALESCEd sum, so nothing is lost.
  // Estimates accumulated in uncosted_cost_usd while the session was resumed
  // are superseded the same way: the new total covers those tokens exactly.
  const reportedCost = session.estimated_cost_usd;
  if (reportedCost != null) {
    statements.push(
      db
        .prepare(
          `UPDATE sessions SET cost_usd = COALESCE(cost_usd, 0), uncosted_cost_usd = 0
          WHERE session_id = ?`
        )
        .bind(sessionId)
    );
  }

  // No reported cost in this upload. Claude Code only reports cost when a
  // session ends, so for a session that has already reported one this is a
  // resumed session mid-flight: its earlier tokens are priced exactly and the
  // new ones not at all. Price the increment with the pricing table so the
  // dashboard keeps moving, and store it separately so it is shown as an
  // estimate and can be replaced when the next reported cost arrives. A
  // session that has never reported a cost keeps cost_usd NULL and is priced
  // at display time as before.
  const sessionHasReportedCost = (prev?.cost_reported_rows ?? 0) > 0;
  const priceIncrement = reportedCost == null && sessionHasReportedCost;
  const costDelta = reportedCost != null ? d(reportedCost, prev?.cost_usd) : priceIncrement ? 0 : null;
  const uncostedDelta = priceIncrement
    ? calculateEstimatedCost(session.model, dInput, dOutput, dCacheRead, dCacheCreation)
    : 0;

  // Add this upload's deltas to the day's row (created on first sight of the
  // day). Additive columns accumulate; metadata reflects the latest upload, and
  // first/last_event_at widen to the session's full span. An identical re-fire
  // yields all-zero deltas, leaving the row unchanged.
  statements.push(
    db
      .prepare(
        `INSERT INTO sessions (
          session_id, day, user_id, project_dir, repo_name, git_branch,
          claude_code_version, model, first_event_at, last_event_at,
          skill_call_count, mcp_call_count, subagent_call_count, conversation_turns,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          cost_usd, uncosted_cost_usd
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, day) DO UPDATE SET
          user_id = excluded.user_id,
          project_dir = excluded.project_dir,
          repo_name = excluded.repo_name,
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
          cache_creation_tokens = sessions.cache_creation_tokens + excluded.cache_creation_tokens,
          -- An upload with no cost must not wipe what an earlier one reported.
          cost_usd = CASE
            WHEN excluded.cost_usd IS NULL THEN sessions.cost_usd
            ELSE COALESCE(sessions.cost_usd, 0) + excluded.cost_usd
          END,
          uncosted_cost_usd = sessions.uncosted_cost_usd + excluded.uncosted_cost_usd`
      )
      .bind(
        sessionId,
        day,
        userId,
        session.project_dir,
        repoName,
        session.git_branch ?? null,
        session.claude_code_version ?? null,
        session.model,
        session.first_event_at,
        session.last_event_at,
        d(skill_events.length, prev?.skill_call_count),
        d(mcp_events.length, prev?.mcp_call_count),
        d(subagent_events.length, prev?.subagent_call_count),
        d(session.conversation_turns, prev?.conversation_turns),
        dInput,
        dOutput,
        dCacheRead,
        dCacheCreation,
        costDelta,
        uncostedDelta
      )
  );

  // Tool usage: count this snapshot's events per (event day, kind, name), then
  // add only the increment over what this session has already contributed to
  // the daily rollup. Names that shrink on re-parse are left as-is (clamped).
  const current = new Map<string, ToolCountRow>();
  const count = (kind: ToolKind, name: string, ts: string) => {
    const eventDay = dayOf(ts, day);
    const key = toolKey(eventDay, kind, name);
    const row = current.get(key);
    if (row) row.call_count += 1;
    else current.set(key, { day: eventDay, kind, name, call_count: 1 });
  };
  for (const e of skill_events) count("skill", e.skill_name, e.timestamp);
  for (const e of mcp_events) count("mcp", e.mcp_server, e.timestamp);
  for (const e of subagent_events) {
    count("subagent", e.subagent_type ?? UNSPECIFIED_SUBAGENT, e.timestamp);
  }

  const credited = new Map<string, number>();
  for (const r of prevToolRes.results) {
    credited.set(toolKey(r.day, r.kind, r.name), r.call_count);
  }

  for (const row of current.values()) {
    const key = toolKey(row.day, row.kind, row.name);
    const delta = d(row.call_count, credited.get(key));
    if (delta === 0) continue;
    statements.push(
      db
        .prepare(
          `INSERT INTO tool_usage_daily (day, user_id, repo_name, kind, name, call_count)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(day, user_id, repo_name, kind, name) DO UPDATE SET
             call_count = tool_usage_daily.call_count + excluded.call_count`
        )
        .bind(row.day, userId, repoName, row.kind, row.name, delta)
    );
    statements.push(
      db
        .prepare(
          `INSERT INTO session_tool_counts (session_id, day, kind, name, call_count)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(session_id, day, kind, name) DO UPDATE SET
             call_count = excluded.call_count`
        )
        .bind(sessionId, row.day, row.kind, row.name, row.call_count)
    );
  }

  // D1 batch: keep each batch comfortably under the bound-parameter limit.
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

type UserRow = { id: number; email: string };
type SumsRow = {
  day: string;
  user_id: number;
  model: string;
  conversation_turns: number;
  skill_call_count: number;
  mcp_call_count: number;
  subagent_call_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  /** Pricing-table estimate for tokens a resumed session added after its last
   *  reported cost; 0 unless the session is mid-resume. */
  uncosted_cost_usd: number;
  /** 1 when the group's rows carry no reported cost (grouped on, so a group is
   *  never a mix of reported and unreported rows). */
  cost_unreported: number;
};
type SessionCountRow = { user_id: number; repo_name: string; session_count: number };
type ToolDailyRow = { day: string; kind: ToolKind; name: string; count: number };
type SessionRow = {
  session_id: string;
  day: string;
  user_id: number;
  repo_name: string;
  model: string;
  first_event_at: string;
  last_event_at: string;
  conversation_turns: number;
  skill_call_count: number;
  mcp_call_count: number;
  subagent_call_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number | null;
  uncosted_cost_usd: number;
};

const rows = <T>(r: D1Result): T[] => r.results as T[];

export async function getDashboardData(
  db: D1Database,
  days: number,
  userId?: number,
  repo?: string,
): Promise<DashboardData> {
  // days === 0 means "all time" — no date filter. The window is measured in
  // whole activity days so every panel (KPI, trend, tools, sessions) sees the
  // same set of rows.
  const hasDateFilter = days > 0;
  const dateFilter = `-${days} days`;

  const filter = (withUserRepo: boolean): { where: string; params: unknown[] } => {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (hasDateFilter) {
      conditions.push(`day >= date('now', ?)`);
      params.push(dateFilter);
    }
    if (withUserRepo && userId !== undefined) {
      conditions.push(`user_id = ?`);
      params.push(userId);
    }
    if (withUserRepo && repo) {
      conditions.push(`repo_name = ?`);
      params.push(repo);
    }
    return { where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "", params };
  };
  const full = filter(true);
  const dateOnly = filter(false);

  // Without ANALYZE statistics SQLite tends to prefer a full scan that yields
  // GROUP BY order over the (much smaller) day-range scan, so name the index.
  const sessionsFrom = (withUserRepo: boolean): string => {
    if (withUserRepo && userId !== undefined) return "sessions INDEXED BY idx_sessions_user_day";
    if (hasDateFilter) return "sessions INDEXED BY idx_sessions_day";
    return "sessions";
  };

  // One round trip; each statement scans the window once. Token/turn/call
  // aggregates are grouped finely enough (day × user × model) to derive the
  // KPI totals, cost by model, user ranking and daily trend in memory.
  // Distinct session counts are grouped by (user, repo) — both constant across
  // a session's day-rows — so they can be re-summed per user, per repo or in
  // total without double counting; the per-model split needs its own query.
  const [usersRes, sumsRes, countsRes, modelRes, toolsRes, recentRes] = await db.batch([
    db.prepare(`SELECT id, email FROM users`),
    db
      .prepare(
        `SELECT day, user_id, model,
          SUM(conversation_turns) AS conversation_turns,
          SUM(skill_call_count) AS skill_call_count,
          SUM(mcp_call_count) AS mcp_call_count,
          SUM(subagent_call_count) AS subagent_call_count,
          SUM(input_tokens) AS input_tokens,
          SUM(output_tokens) AS output_tokens,
          SUM(cache_read_tokens) AS cache_read_tokens,
          SUM(cache_creation_tokens) AS cache_creation_tokens,
          COALESCE(SUM(cost_usd), 0) AS cost_usd,
          COALESCE(SUM(uncosted_cost_usd), 0) AS uncosted_cost_usd,
          cost_usd IS NULL AS cost_unreported
        FROM ${sessionsFrom(true)}
        ${full.where}
        GROUP BY day, user_id, model, cost_usd IS NULL`
      )
      .bind(...full.params),
    db
      .prepare(
        `SELECT user_id, repo_name, COUNT(DISTINCT session_id) AS session_count
        FROM ${sessionsFrom(false)}
        ${dateOnly.where}
        GROUP BY user_id, repo_name`
      )
      .bind(...dateOnly.params),
    db
      .prepare(
        `SELECT model AS name, COUNT(DISTINCT session_id) AS count
        FROM ${sessionsFrom(true)}
        ${full.where}
        GROUP BY model
        ORDER BY count DESC`
      )
      .bind(...full.params),
    db
      .prepare(
        `SELECT day, kind, name, SUM(call_count) AS count
        FROM tool_usage_daily
        ${full.where}
        GROUP BY day, kind, name`
      )
      .bind(...full.params),
    // Recent sessions: pick the most recently active sessions in the window,
    // then pull every day-row of just those sessions (PK lookups) so each entry
    // shows the session's full totals plus its latest day's portion.
    db
      .prepare(
        `SELECT session_id, day, user_id, repo_name, model, first_event_at, last_event_at,
          conversation_turns, skill_call_count, mcp_call_count, subagent_call_count,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          cost_usd, uncosted_cost_usd
        FROM sessions
        WHERE session_id IN (
          SELECT session_id FROM ${sessionsFrom(true)}
          ${full.where}
          GROUP BY session_id
          ORDER BY MAX(last_event_at) DESC
          LIMIT ${RECENT_SESSIONS_LIMIT}
        )
        ORDER BY session_id, day`
      )
      .bind(...full.params),
  ]);

  const emailById = new Map(rows<UserRow>(usersRes).map((u) => [u.id, u.email]));
  const emailOf = (id: number) => emailById.get(id) ?? "";

  // KPI totals, cost per user and daily trend from the summed rows.
  const kpi: KpiData = {
    total_sessions: 0,
    total_conversation_turns: 0,
    total_skill_calls: 0,
    total_mcp_calls: 0,
    total_subagent_calls: 0,
    total_tokens: 0,
    total_estimated_cost: 0,
    estimated_cost_portion: 0,
  };
  const costByUser = new Map<number, number>();
  const dailyMap = new Map<string, DailyTrendEntry>();
  for (const r of rows<SumsRow>(sumsRes)) {
    // Rows Claude Code priced itself are already summed per model; the rest
    // fall back to the pricing table at the group's single model rate. Tokens a
    // resumed session added after its last reported cost were priced at ingest
    // (uncosted_cost_usd) and count as estimated too.
    const estimated = r.cost_unreported
      ? calculateEstimatedCost(
          r.model, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_creation_tokens
        )
      : r.uncosted_cost_usd;
    const cost = r.cost_unreported ? estimated : r.cost_usd + r.uncosted_cost_usd;
    const tokens = r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_creation_tokens;

    kpi.total_conversation_turns += r.conversation_turns;
    kpi.total_skill_calls += r.skill_call_count;
    kpi.total_mcp_calls += r.mcp_call_count;
    kpi.total_subagent_calls += r.subagent_call_count;
    kpi.total_tokens += tokens;
    kpi.total_estimated_cost += cost;
    kpi.estimated_cost_portion += estimated;

    costByUser.set(r.user_id, (costByUser.get(r.user_id) ?? 0) + cost);

    const daily = dailyMap.get(r.day) ?? {
      date: r.day, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, estimated_cost: 0,
    };
    daily.input_tokens += r.input_tokens;
    daily.output_tokens += r.output_tokens;
    daily.cache_read_tokens += r.cache_read_tokens;
    daily.cache_creation_tokens += r.cache_creation_tokens;
    daily.estimated_cost += cost;
    dailyMap.set(r.day, daily);
  }
  const dailyTrend = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  // Session counts: selectors ignore the user/repo filter; everything else
  // applies it.
  const sessionsByUser = new Map<number, number>();
  const sessionsByRepo = new Map<string, number>();
  const filteredSessionsByUser = new Map<number, number>();
  for (const r of rows<SessionCountRow>(countsRes)) {
    sessionsByUser.set(r.user_id, (sessionsByUser.get(r.user_id) ?? 0) + r.session_count);
    sessionsByRepo.set(r.repo_name, (sessionsByRepo.get(r.repo_name) ?? 0) + r.session_count);
    const matches = (userId === undefined || r.user_id === userId) && (!repo || r.repo_name === repo);
    if (matches) {
      kpi.total_sessions += r.session_count;
      filteredSessionsByUser.set(r.user_id, (filteredSessionsByUser.get(r.user_id) ?? 0) + r.session_count);
    }
  }

  const userRanking: UserRankingEntry[] = Array.from(filteredSessionsByUser, ([id, total_sessions]) => ({
    user_id: id,
    email: emailOf(id),
    total_cost: costByUser.get(id) ?? 0,
    total_sessions,
  }))
    .sort((a, b) => b.total_cost - a.total_cost)
    .slice(0, USER_RANKING_LIMIT);

  const users: UserEntry[] = Array.from(sessionsByUser, ([id, session_count]) => ({
    user_id: id,
    email: emailOf(id),
    session_count,
  })).sort((a, b) => b.session_count - a.session_count);

  const repos: RepoEntry[] = Array.from(sessionsByRepo, ([repo_name, session_count]) => ({
    repo_name,
    session_count,
  })).sort((a, b) => b.session_count - a.session_count);

  // Tool usage: distributions per kind and the per-day stacked counts.
  const dist: Record<ToolKind, Map<string, number>> = {
    skill: new Map(),
    mcp: new Map(),
    subagent: new Map(),
  };
  const dailyTools = new Map<string, DailyToolUsageEntry>();
  for (const r of rows<ToolDailyRow>(toolsRes)) {
    const byName = dist[r.kind];
    if (!byName) continue;
    byName.set(r.name, (byName.get(r.name) ?? 0) + r.count);
    const entry = dailyTools.get(r.day) ?? { date: r.day, skill_count: 0, mcp_count: 0, subagent_count: 0 };
    if (r.kind === "skill") entry.skill_count += r.count;
    else if (r.kind === "mcp") entry.mcp_count += r.count;
    else entry.subagent_count += r.count;
    dailyTools.set(r.day, entry);
  }
  const toDistribution = (m: Map<string, number>): DistributionEntry[] =>
    Array.from(m, ([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  const dailyToolUsage = Array.from(dailyTools.values()).sort((a, b) => a.date.localeCompare(b.date));

  // Recent sessions: collapse day-rows (ordered by day) into one entry each.
  // Metadata comes from the latest day-row, which also provides the
  // "latest day" portion shown next to the totals.
  const bySession = new Map<string, SessionRow[]>();
  for (const r of rows<SessionRow>(recentRes)) {
    const list = bySession.get(r.session_id);
    if (list) list.push(r);
    else bySession.set(r.session_id, [r]);
  }
  // Per day-row, so a session whose rows are partly reported adds up correctly
  // and the fallback uses that day's own model rather than the latest one.
  const rowCost = (r: SessionRow) =>
    r.cost_usd == null
      ? calculateEstimatedCost(
          r.model, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_creation_tokens
        )
      : r.cost_usd + r.uncosted_cost_usd;
  const rowIsEstimated = (r: SessionRow) => r.cost_usd == null || r.uncosted_cost_usd > 0;
  const durationSeconds = (first: string, last: string) => {
    const ms = Date.parse(last) - Date.parse(first);
    return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  };
  const recentSessions: RecentSessionEntry[] = Array.from(bySession.values())
    .map((dayRows) => {
      const latest = dayRows[dayRows.length - 1];
      const sum = (pick: (r: SessionRow) => number) => dayRows.reduce((acc, r) => acc + pick(r), 0);
      const first_event_at = dayRows.reduce((m, r) => (r.first_event_at < m ? r.first_event_at : m), latest.first_event_at);
      const last_event_at = dayRows.reduce((m, r) => (r.last_event_at > m ? r.last_event_at : m), latest.last_event_at);
      const input_tokens = sum((r) => r.input_tokens);
      const output_tokens = sum((r) => r.output_tokens);
      const cache_read_tokens = sum((r) => r.cache_read_tokens);
      const cache_creation_tokens = sum((r) => r.cache_creation_tokens);
      return {
        session_id: latest.session_id,
        user_id: latest.user_id,
        email: emailOf(latest.user_id),
        repo_name: latest.repo_name,
        model: latest.model,
        duration_seconds: durationSeconds(first_event_at, last_event_at),
        conversation_turns: sum((r) => r.conversation_turns),
        skill_call_count: sum((r) => r.skill_call_count),
        mcp_call_count: sum((r) => r.mcp_call_count),
        subagent_call_count: sum((r) => r.subagent_call_count),
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens,
        estimated_cost_usd: sum(rowCost),
        cost_is_estimated: dayRows.some(rowIsEstimated),
        latest_conversation_turns: latest.conversation_turns,
        latest_skill_call_count: latest.skill_call_count,
        latest_mcp_call_count: latest.mcp_call_count,
        latest_subagent_call_count: latest.subagent_call_count,
        latest_total_tokens:
          latest.input_tokens + latest.output_tokens + latest.cache_read_tokens + latest.cache_creation_tokens,
        latest_estimated_cost_usd: rowCost(latest),
        latest_cost_is_estimated: rowIsEstimated(latest),
        last_event_at,
      };
    })
    .sort((a, b) => b.last_event_at.localeCompare(a.last_event_at));

  return {
    kpi,
    userRanking,
    skillDistribution: toDistribution(dist.skill),
    mcpDistribution: toDistribution(dist.mcp),
    modelDistribution: rows<DistributionEntry>(modelRes),
    subagentDistribution: toDistribution(dist.subagent),
    dailyTrend,
    dailyToolUsage,
    recentSessions,
    users,
    repos,
    days,
    filterUserId: userId,
    filterUserEmail: userId !== undefined ? emailById.get(userId) : undefined,
    filterRepo: repo,
  };
}

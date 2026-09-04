-- Store the cost Claude Code itself reports for a session, so the dashboard
-- stops deriving every figure from its hand-maintained pricing table.
--
-- Why: sessions.model holds a single model (the most frequent one), and the
-- whole session's tokens were priced at that model's rate — a Haiku subagent
-- running under Opus was billed as Opus. The hook now sends the cumulative
-- totalCostUSD from the transcript's cost-state record, which is already
-- summed per model.
--
-- NULL means "not reported" (older rows, or a session Claude Code tracked no
-- cost for); those rows keep falling back to app/lib/cost.ts. Like the other
-- additive columns, the value stored here is only that day's increment.
--
-- Additive change: no table is rebuilt and no data is dropped.

ALTER TABLE sessions ADD COLUMN cost_usd REAL;

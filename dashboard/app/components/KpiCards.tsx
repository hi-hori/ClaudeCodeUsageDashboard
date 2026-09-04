import type { KpiData } from "~/lib/types";
import { formatTokens } from "~/lib/format";
import { ESTIMATED_COST_HINT } from "~/lib/constants";

const numberFormat = new Intl.NumberFormat("en-US");
const currencyFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

interface KpiCardProps {
  label: string;
  value: string;
  /** Dimmed line under the value, for a caveat about the number above. */
  note?: string;
  noteTitle?: string;
}

function KpiCard({ label, value, note, noteTitle }: KpiCardProps) {
  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-4">
      <p className="text-sm text-gray-500 dark:text-gray-400">{label}</p>
      <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-1">
        {value}
      </p>
      {note && (
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5" title={noteTitle}>
          {note}
        </p>
      )}
    </div>
  );
}

export function KpiCards({ kpi }: { kpi: KpiData }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
      <KpiCard label="Sessions" value={numberFormat.format(kpi.total_sessions)} />
      <KpiCard label="Turns" value={numberFormat.format(kpi.total_conversation_turns)} />
      <KpiCard label="Skill Calls" value={numberFormat.format(kpi.total_skill_calls)} />
      <KpiCard label="MCP Calls" value={numberFormat.format(kpi.total_mcp_calls)} />
      <KpiCard label="SubAgent Calls" value={numberFormat.format(kpi.total_subagent_calls)} />
      <KpiCard
        label="Est. Cost"
        value={currencyFormat.format(kpi.total_estimated_cost)}
        note={
          kpi.estimated_cost_portion > 0
            ? `${currencyFormat.format(kpi.estimated_cost_portion)} estimated`
            : undefined
        }
        noteTitle={ESTIMATED_COST_HINT}
      />
      <KpiCard label="Tokens" value={formatTokens(kpi.total_tokens)} />
    </div>
  );
}

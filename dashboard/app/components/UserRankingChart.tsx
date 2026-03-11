import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { UserRankingEntry } from "~/lib/types";

export function UserRankingChart({ data }: { data: UserRankingEntry[] }) {
  const chartData = data.map((entry) => ({
    ...entry,
    // Show email prefix for readability
    name: entry.email.split("@")[0],
  }));

  if (chartData.length === 0) {
    return <EmptyState />;
  }

  return (
    <ChartCard title="ユーザーランキング（コスト順）">
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={chartData} layout="vertical" margin={{ left: 20, right: 20, top: 5, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis type="number" tickFormatter={(v) => `$${v.toFixed(0)}`} />
          <YAxis type="category" dataKey="name" width={100} />
          <Tooltip
            formatter={(value: number) => [`$${value.toFixed(2)}`, "コスト"]}
          />
          <Bar dataKey="total_cost" fill="#3b82f6" radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

function ChartCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-4">
      <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-4">
        {title}
      </h3>
      {children}
    </div>
  );
}

function EmptyState() {
  return (
    <ChartCard title="ユーザーランキング（コスト順）">
      <div className="flex items-center justify-center h-[300px] text-gray-400">
        データがありません
      </div>
    </ChartCard>
  );
}

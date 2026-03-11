import { useSearchParams } from "react-router";

const PERIODS = [
  { days: 7, label: "7日" },
  { days: 30, label: "30日" },
  { days: 0, label: "全期間" },
];

export function PeriodSelector({ currentDays }: { currentDays: number }) {
  const [, setSearchParams] = useSearchParams();

  return (
    <div className="flex gap-2">
      {PERIODS.map(({ days, label }) => (
        <button
          key={days}
          onClick={() => setSearchParams({ days: String(days) })}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            currentDays === days
              ? "bg-blue-600 text-white"
              : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

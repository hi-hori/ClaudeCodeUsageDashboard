# Claude Code Usage Dashboard

A dashboard to visualize and share Claude Code usage across your team.

## Overview

- **Data Collection**: Automatically parses and submits transcripts via Stop hook at session end
- **Visualization**: Charts for skill usage, MCP tool usage, sub-agent usage, token consumption, estimated costs, and more
- **Authentication**: No app-level auth (secured externally via Cloudflare Zero Trust)

## Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | React Router v7 |
| Hosting | Cloudflare Workers |
| Database | Cloudflare D1 (SQLite) |
| Charts | Recharts |
| UI | Tailwind CSS |
| Data Collection | Python Stop hook + curl |

## Local Development

### Prerequisites

- Node.js 18+
- Wrangler CLI (`npm install -g wrangler`)

### Setup

1. Install dependencies:

```bash
cd dashboard
npm install
```

2. Apply migrations to local D1:

```bash
npx wrangler d1 migrations apply claude-code-usage --local
```

3. Start the dev server:

```bash
npm run dev
```

The application will be available at `http://localhost:5173`.

## Stop Hook Configuration

The Stop hook is implemented in `.claude/hooks/session-uploader.py` and automatically submits data when a Claude Code session ends.

### Activation

1. Verify the Stop hook is registered in `.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/session-uploader.py"
          }
        ]
      }
    ]
  }
}
```

2. Verify Claude Code is authenticated (email is used for user identification):

```bash
claude auth status
```

### How the Hook Works

1. Stop hook fires at session end
2. Parses `~/.claude/projects/{hash}/{session_id}.jsonl`
3. Extracts skill usage, MCP tool usage, sub-agent usage, and token counts
4. Retrieves email via `claude auth status`
5. POSTs to the API with Service Token headers (runs in background)


## Directory Structure

```
dashboard/
├── app/
│   ├── entry.client.tsx          # Client entry
│   ├── entry.server.tsx          # Server entry
│   ├── root.tsx                  # Root layout
│   ├── routes.ts                 # Route definitions
│   ├── routes/
│   │   ├── home.tsx              # Dashboard page (loader + UI)
│   │   └── api.v1.usage.ingest.ts  # Ingest API (POST)
│   ├── lib/
│   │   ├── types.ts              # Shared type definitions
│   │   ├── cost.ts               # Per-model pricing table + cost calculation
│   │   └── db.server.ts          # D1 query helpers
│   └── components/
│       ├── KpiCards.tsx           # KPI cards (7 cards)
│       ├── PeriodSelector.tsx     # Period selector
│       ├── UserRankingChart.tsx   # User ranking (horizontal bar)
│       ├── DistributionPieChart.tsx  # Generic pie chart
│       ├── CostTokenTrendChart.tsx   # Cost & token trend
│       ├── DailyToolUsageChart.tsx   # Daily tool usage trend
│       └── RecentSessionsTable.tsx   # Recent sessions table
├── workers/
│   └── app.ts                    # Cloudflare Workers entry point
├── migrations/
│   └── 0001_initial.sql          # D1 schema
├── wrangler.toml
├── package.json
├── tsconfig.json
├── vite.config.ts
└── react-router.config.ts
```

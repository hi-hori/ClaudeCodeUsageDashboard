# Claude Code 利用状況ダッシュボード

SecDev-Lab チームの Claude Code 活用状況を可視化するダッシュボードです。

## 概要

- **データ収集**: Claude Code セッション終了時に Stop フックでトランスクリプトを自動解析・送信
- **可視化**: スキル利用、MCP ツール利用、サブエージェント利用、トークン消費量、推定コスト等をチャート表示
- **認証**: アプリ層では認証なし（Cloudflare Zero Trust で外側から担保）

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| フレームワーク | React Router v7 |
| ホスティング | Cloudflare Workers |
| データベース | Cloudflare D1 (SQLite) |
| チャート | Recharts |
| UI | Tailwind CSS |
| データ収集 | Python Stop フック + curl |

## ローカル開発

### 前提条件

- Node.js 18+
- Wrangler CLI (`npm install -g wrangler`)

### セットアップ

1. 依存関係をインストール:

```bash
cd dashboard
npm install
```

2. ローカル D1 にマイグレーション適用:

```bash
npx wrangler d1 migrations apply claude-code-usage --local
```

3. 開発サーバーを起動:

```bash
npm run dev
```

アプリケーションは `http://localhost:5173` で利用可能です。
## Stop フック設定

Claude Code セッション終了時にデータを自動送信するフックが `.claude/hooks/session-uploader.py` に実装されています。

### 有効化手順

1. `.claude/settings.json` に Stop フックが登録済みであることを確認:

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

2. Claude Code が認証済みであることを確認（メールアドレスがユーザー識別に使用されます）:

```bash
claude auth status
```

### フックの動作

1. セッション終了時に Stop フックが発火
2. `~/.claude/projects/{hash}/{session_id}.jsonl` をパース
3. スキル利用、MCP ツール利用、サブエージェント利用、トークン数を抽出
4. `claude auth status` でメールアドレスを取得
5. Service Token ヘッダー付きで API に POST（バックグラウンド実行）


## ディレクトリ構造

```
dashboard/
├── app/
│   ├── entry.client.tsx          # クライアントエントリー
│   ├── entry.server.tsx          # サーバーエントリー
│   ├── root.tsx                  # ルートレイアウト
│   ├── routes.ts                 # ルート定義
│   ├── routes/
│   │   ├── home.tsx              # ダッシュボードページ（loader + UI）
│   │   └── api.v1.usage.ingest.ts  # Ingest API（POST）
│   ├── lib/
│   │   ├── types.ts              # 共通型定義
│   │   ├── cost.ts               # モデル別料金テーブル + コスト計算
│   │   └── db.server.ts          # D1 クエリヘルパー
│   └── components/
│       ├── KpiCards.tsx           # KPI カード（7枚）
│       ├── PeriodSelector.tsx     # 期間セレクタ
│       ├── UserRankingChart.tsx   # ユーザーランキング（横棒）
│       ├── DistributionPieChart.tsx  # 汎用円グラフ
│       ├── CostTokenTrendChart.tsx   # コスト・トークン推移
│       ├── DailyToolUsageChart.tsx   # 日別ツール利用推移
│       └── RecentSessionsTable.tsx   # 最近のセッション一覧
├── workers/
│   └── app.ts                    # Cloudflare Workers エントリポイント
├── migrations/
│   └── 0001_initial.sql          # D1 スキーマ
├── wrangler.toml
├── package.json
├── tsconfig.json
├── vite.config.ts
└── react-router.config.ts
```

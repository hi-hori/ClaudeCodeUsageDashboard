#!/usr/bin/env bash
set -euo pipefail

WRANGLER_TOML="dashboard/wrangler.toml"

usage() {
  echo "Usage: $0 <database_id>"
  echo ""
  echo "D1 の database_id を設定し、ダッシュボードをデプロイします。"
  echo ""
  echo "Example:"
  echo "  $0 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  exit 1
}

if [[ $# -ne 1 ]]; then
  usage
fi

DATABASE_ID="$1"

if [[ ! -f "$WRANGLER_TOML" ]]; then
  echo "Error: $WRANGLER_TOML が見つかりません。リポジトリルートから実行してください。" >&2
  exit 1
fi

echo "📝 database_id を設定中..."
sed -i '' "s|database_id = \".*\"|database_id = \"$DATABASE_ID\"|" "$WRANGLER_TOML"
echo "✅ database_id を設定しました: $DATABASE_ID"

echo ""
echo "📦 デプロイ中..."
cd dashboard
npm install
npx wrangler d1 migrations apply claude-code-usage --remote
npm run deploy

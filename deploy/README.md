# デプロイ手順

`dashboard/` を Cloudflare Workers + D1 にデプロイする手順です。

## 前提条件

- Cloudflare アカウント
- Wrangler CLI インストール・ログイン済み

```bash
npm install -g wrangler
wrangler login
```

## 初回セットアップ

### 1. D1 データベース作成

```bash
wrangler d1 create claude-code-usage
```

出力例:

```
✅ Successfully created DB 'claude-code-usage'
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

### 2. デプロイ

出力された `database_id` を指定してデプロイスクリプトを実行します。
database_id の設定、マイグレーション適用、デプロイを一括で行います。

```bash
./deploy/deploy.sh <database_id>
```

デプロイ完了後、Workers の URL がターミナルに表示されます（例: `https://claude-code-usage-dashboard.<account>.workers.dev`）。

2回目以降のデプロイも同じコマンドで実行できます。

## Zero Trust 設定（認証・初回のみ手動）

Cloudflare Zero Trust でアクセス制御を行います。
ダッシュボード閲覧（ブラウザ）と Ingest API（Stop フック）の 2 種類の認証を 1 つの Access Application で設定します。

### ステップ 1: Access Application を作成

1. [Cloudflare Zero Trust ダッシュボード](https://one.dash.cloudflare.com/) → **Access controls** → **Applications**
2. **Add an application** → **Self-hosted** を選択
3. Basic information を設定:

| 項目 | 値 |
|------|---|
| Application name | `Claude Code Usage Dashboard` |
| Session Duration | `24 hours`（任意） |

4. **+ Add public hostname** をクリックし、Workers の URL を入力:

| 項目 | 値 |
|------|---|
| Subdomain | `claude-code-usage-dashboard` |
| Domain | `<account>.workers.dev` |

### ステップ 2: ダッシュボード閲覧用ポリシー

Application 内で 1 つ目の Policy を作成します。組織の認証要件に応じて設定してください。

設定例：

| 項目 | 値 |
|------|---|
| Policy name | `Allow Developer members` |
| Action | **Allow** |
| Include rule | Emails ending in `@example.com` |
| Identity providers | **Google** を選択 |


### ステップ 3: Service Token の作成（Ingest API 用）

Stop フックからの API 送信に使用する Service Token を作成します。

1. Zero Trust ダッシュボード → **Access control** → **Service Credentials** → **Service Tokens**
2. **Create Service Token** をクリック
3. 名前: `Claude Code Usage Dashboard Ingest`
4. 発行された `CF-Access-Client-Id` と `CF-Access-Client-Secret` を控える


### ステップ 4: Service Token ポリシーの追加

ステップ 1 で作成した Access Application に 2 つ目の Policy を追加します:

| 項目 | 値 |
|------|---|
| Policy name | `Allow Ingest API Service Token` |
| Action | **Service Auth** |
| Include rule | Service Token → `Claude Code Usage Dashboard Ingest` を選択 |

これにより、`CF-Access-Client-Id` / `CF-Access-Client-Secret` ヘッダー付きリクエストは認証を通過します。


## チームメンバーへの配布

各メンバーがプラグインをインストールし、環境変数を設定します。
手順はルートの [README.md](../README.md) の「セットアップ」を参照してください。

Zero Trust を使用する場合は、`.env` に以下も追加します:

```bash
CLAUDE_CODE_USAGE_DASHBOARD_CF_ACCESS_CLIENT_ID="<Client ID>"
CLAUDE_CODE_USAGE_DASHBOARD_CF_ACCESS_CLIENT_SECRET="<Client Secret>"
```

## スキーマ更新時

`migrations/` に新しいマイグレーション SQL を追加した場合:

```bash
wrangler d1 migrations apply claude-code-usage --remote
```

> ローカル環境には `--local` フラグで適用します。

## DB リセット（全データ削除 + スキーマ再作成）

スキーマに破壊的変更を加えた場合など、DB をクリーンな状態に戻す手順です。

> **注意**: 全データが削除されます。本番運用中は十分注意してください。

```bash
cd dashboard

# 1. 全テーブルとマイグレーション履歴を削除
wrangler d1 execute claude-code-usage --remote --command "DROP TABLE IF EXISTS subagent_usage_events; DROP TABLE IF EXISTS mcp_usage_events; DROP TABLE IF EXISTS skill_usage_events; DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS users; DROP TABLE IF EXISTS d1_migrations;"

# 2. マイグレーション再適用
wrangler d1 migrations apply claude-code-usage --remote
```

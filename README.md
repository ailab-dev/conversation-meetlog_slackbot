# Slack ナレッジ収集ボット（RAG 検索付き）

Slack のチャンネルに参加するだけで全メッセージを自動収集し、Notion データベースへ保存するボット。
保存したナレッジは `@knowledgeBot` へのメンションで AI 検索できます（RAG）。

---

## 機能一覧

### タスク管理（フェーズ6）

- タスクキーワード（`〜までに` `期限` `ToDo` `してください` など）を含むメッセージを自動検知
- ボットが「タスクに追加しますか？」と確認ボタン付きで質問（誤検知防止）
- 確認後、Gemini が期日を自然言語から自動抽出（「来週月曜」「3/31」など → YYYY-MM-DD）
- 期日が検出できなかった場合は日付ピッカーを表示して選択させる
- 投稿者がタスク担当者として Notion に登録される
- 毎朝 9:00 JST に期日 2日前・前日・当日を担当者への @メンション付きでチャンネルに通知
- スレッド返信で完了キーワード（`完了` `done` など）を検知すると Notion を自動更新し完了通知

### 自動収集（フェーズ5）

- ボットが参加しているチャンネルの**全メッセージを自動保存**（リアクション不要）
- スレッド返信は親メッセージの Notion ページに追記（スレッド単位でまとめて管理）
- `@knowledgeBot` 宛てのメンションメッセージは収集対象から除外
- ボットが新しいチャンネルに参加した時点で自動収集モードをON
- 過去メッセージの一括収集（確認ボタン付き）
- 既存チャンネルへの一括有効化スクリプト（`scripts/enable-autocollect.ts`）

### AI 検索 RAG（フェーズ2）

`@knowledgeBot` にメンションするとナレッジを検索して直接回答します：

```
@knowledgeBot 先月の開発方針はどうなりましたか？
```

- 保存済みナレッジからベクター類似検索（上位5件）
- Gemini AI が内容をもとに日本語で直接回答（前置きなし）
- 回答末尾に参照したナレッジの出典リンクを表示

### コンテンツ拡張抽出（フェーズ3）

メッセージに含まれる外部コンテンツを自動取得し、Notion への保存内容とベクトル検索精度を向上：

| 対象 | 処理方法 | 文字数上限 |
|------|----------|-----------|
| URL（最大3件） | fetch + cheerio で HTML 本文抽出（タイムアウト 8秒） | 3,000文字/件 |
| PDF 添付 | Gemini Vision で解析 | 5,000文字 |
| 画像添付 | Gemini Vision で説明テキスト化 | 2,000文字 |
| X (Twitter) URL | 現在除外（認証必須・ボット検知リスクのため） | — |

---

## RAG の仕組み

### ナレッジ蓄積フロー（メッセージ投稿時）

```
Slack にメッセージ投稿
  → 自動収集モードのチャンネルか確認（Redis: autocollect:{channelId}）
  → 重複チェック（Redis: knowledge:{channelId}:{ts}_bulk）
  → スレッド返信は親ページに追記 / 親メッセージは新規ページ作成
  → メッセージ本文 + URL/PDF/画像テキストを Gemini Embedding でベクトル化（1536次元）
  → Upstash Vector に保存（ベクトル＋メタデータ）
  → Notion DB にも同時保存
```

### 検索・回答フロー（@メンション時）

```
@knowledgeBot への質問
  → 質問文を Gemini Embedding でベクトル化
  → Upstash Vector で類似度の高いナレッジを上位5件取得
  → 取得したナレッジ全文 + 質問を Gemini Flash に渡す
  → Gemini が内容をもとに日本語で直接回答
  → Slack に回答＋出典リンクを返信
```

質問文と意味的に近いナレッジだけを絞り込んでから AI に渡すことで、ナレッジ量が増えても精度を保ちます（RAG の核心）。

---

## 技術スタック

| カテゴリ | 技術 | 用途 |
|---------|------|------|
| フレームワーク | **Next.js 14** (App Router) / Vercel | API Routes でイベント受信・処理 |
| Slack | **@slack/web-api** | イベント受信・メッセージ取得・返信送信 |
| Notion | **@notionhq/client** | ナレッジページ作成・スレッド返信追記 |
| Redis | **@upstash/redis** | 重複防止・自動収集フラグ・Notionページ ID キャッシュ |
| ベクター DB | **@upstash/vector** | ベクター検索インデックス（Dense / 1536次元 / Cosine） |
| AI | **@google/generative-ai** | Embedding 生成（`gemini-embedding-001`）・回答生成 / PDF・画像解析（`gemini-2.5-flash`） |
| HTML解析 | **cheerio** | URL コンテンツのテキスト抽出 |
| バックグラウンド処理 | **@upstash/qstash** | 過去メッセージ一括収集（タイムアウト回避） |
| 定期実行 | **Vercel Cron** | 毎朝9時のリマインダー送信（UTC 0:00） |

---

## セットアップ

### 1. 依存パッケージのインストール

```bash
npm install
```

### 2. Notion の設定

**2-1. データベースを作成**

Notion で新規ページを作成し、フルページデータベースを挿入。以下のプロパティを追加する。

| プロパティ名 | 種別 | 備考 |
|------------|------|------|
| `Title` | タイトル | デフォルトの「名前」を `Title` に改名すること |
| `Category` | セレクト | |
| `PostedBy` | テキスト | |
| `SlackChannel` | テキスト | |
| `SavedAt` | 日付 | |

> ⚠️ プロパティ名は大文字・小文字を含め完全一致が必要です。

**2-2. インテグレーションを作成**

1. [notion.so/my-integrations](https://www.notion.so/my-integrations) で「新しいインテグレーション」を作成
2. 種類は **「内部インテグレーション」** を選択
3. 発行されたトークン（`secret_...`）をコピー

**2-3. データベースにインテグレーションを接続**

データベースページを開き、右上「**...**」→「**コネクト先**」→ 作成したインテグレーションを選択。

> ⚠️ この接続をしないと API からアクセスできません（`object_not_found` エラー）。

**2-4. データベース ID を取得**

```
https://www.notion.so/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx?v=...
                       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ ← これが NOTION_DATABASE_ID
```

### 3. Slack App の設定

1. [api.slack.com/apps](https://api.slack.com/apps) で「Create New App」→「From scratch」
2. **OAuth & Permissions** → Bot Token Scopes に以下を追加：

| スコープ | 用途 |
|---------|------|
| `channels:history` | パブリックチャンネルのメッセージ・スレッド取得 |
| `channels:read` | チャンネル情報の取得 |
| `groups:history` | プライベートチャンネルのメッセージ・スレッド取得 |
| `groups:read` | プライベートチャンネル情報の取得 |
| `chat:write` | メッセージ送信 |
| `users:read` | 投稿者の表示名取得 |
| `app_mentions:read` | @メンションイベントの受信 |

3. 「Install to Workspace」でインストール → `xoxb-...` トークンをコピー
4. **Basic Information** → Signing Secret をコピー
5. **Basic Information** → App Credentials → Bot User ID をコピー（`SLACK_BOT_USER_ID` に設定）

**Event Subscriptions の設定：**

**Event Subscriptions** → **Subscribe to bot events** に以下を追加：

| イベント | 用途 |
|---------|------|
| `message.channels` | パブリックチャンネルのメッセージ自動収集 |
| `message.groups` | プライベートチャンネルのメッセージ自動収集 |
| `app_mention` | @メンションによる RAG 検索 |
| `member_joined_channel` | ボット参加時の自動収集モードON |

### 4. Upstash Redis の設定

[upstash.com](https://upstash.com) で Redis データベースを作成し、REST URL と REST Token をコピー。

### 5. Upstash Vector の設定

[console.upstash.com](https://console.upstash.com) で Vector インデックスを作成：

| 設定項目 | 値 |
|---------|-----|
| Type | **Dense** |
| Dimensions | **1536** |
| Distance Metric | **Cosine** |

### 6. Gemini API キーの取得

[aistudio.google.com](https://aistudio.google.com) で API キーを作成し、コピー。

### 7. 環境変数の設定

```bash
cp .env.local.example .env.local
```

`.env.local` を編集して各値を入力：

```
# Slack
SLACK_BOT_TOKEN=xoxb-YOUR_BOT_TOKEN
SLACK_SIGNING_SECRET=YOUR_SIGNING_SECRET
SLACK_BOT_USER_ID=UXXXXXXXXXX

# Upstash Redis
UPSTASH_REDIS_REST_URL=https://YOUR_REDIS_HOST.upstash.io
UPSTASH_REDIS_REST_TOKEN=YOUR_REDIS_TOKEN

# Notion
NOTION_TOKEN=secret_YOUR_NOTION_TOKEN
NOTION_DATABASE_ID=YOUR_DATABASE_ID（32文字）

# Gemini
GEMINI_API_KEY=YOUR_GEMINI_API_KEY

# Upstash Vector
UPSTASH_VECTOR_REST_URL=https://YOUR_VECTOR_HOST.upstash.io
UPSTASH_VECTOR_REST_TOKEN=YOUR_VECTOR_TOKEN

# QStash（一括収集用）
QSTASH_TOKEN=YOUR_QSTASH_TOKEN

# Vercel 本番 URL（QStash のコールバック先）
VERCEL_PROJECT_PRODUCTION_URL=your-app.vercel.app

# Vercel Cron 認証シークレット（任意の文字列）
CRON_SECRET=your-random-secret
```

### 8. Vercel デプロイ

1. GitHub にプッシュして Vercel に連携
2. Vercel ダッシュボード → **Settings → Environment Variables** に `.env.local` の全変数を追加
3. 環境変数追加後に **Redeploy** を実行
4. Slack App の Request URL を Vercel の本番 URL に更新：
   ```
   https://your-app.vercel.app/api/slack/events
   ```

### 9. Notion DB に DueDate プロパティを追加（フェーズ6）

Notion のナレッジデータベースに以下のプロパティを手動で追加する：

| プロパティ名 | 種別 |
|------------|------|
| `DueDate` | 日付（date） |

> ⚠️ プロパティ名は完全一致が必要です。追加しないとタスク期日の保存・リマインダーが動作しません。

### 10. 既存チャンネルへの自動収集を有効化

デプロイ後、ボットがすでに参加しているチャンネルに一括で自動収集モードを設定：

```bash
# 対象チャンネルを確認（実際の変更なし）
npx tsx scripts/enable-autocollect.ts --dry-run

# 実際に有効化
npx tsx scripts/enable-autocollect.ts
```

---

## ローカル開発

```bash
# 開発サーバー起動
npm run dev

# 別ターミナルで ngrok を起動
npx ngrok http 3000
```

Slack App の **Event Subscriptions** → Request URL に ngrok の URL を設定：

```
https://xxxx.ngrok-free.app/api/slack/events
```

> ⚠️ `/api/slack/events` まで含めること。ルートパスのみでは 405 エラーになります。

---

## ディレクトリ構成

```
app/
  api/
    slack/
      events/route.ts    # Slack Events API 受信（自動収集・タスク検知・RAG・参加検知）
      actions/route.ts   # Block Kit ボタン応答（収集確認・タスク確認・日付ピッカー）
      collect/route.ts   # QStash 経由の一括収集処理
    cron/
      remind/route.ts    # 毎朝 9:00 JST のタスクリマインダー（Vercel Cron）
lib/
  slack.ts               # 署名検証・メッセージ送信・Block Kit 送信・タスク通知
  notion.ts              # Notion ページ作成・更新・スレッド返信追記・タスク検索
  redis.ts               # 重複防止・自動収集フラグ・Notion ページ ID・タスクメタ キャッシュ
  gemini.ts              # Embedding 生成・RAG 回答生成
  vector.ts              # ベクター登録・類似検索（Upstash Vector）
  extractor.ts           # URL・PDF・画像テキスト抽出
  collect.ts             # 単一メッセージの保存処理（一括収集・自動収集共通）
  task.ts                # タスクキーワード検知・Gemini 期日抽出
types/
  knowledge.ts           # 型定義
scripts/
  enable-autocollect.ts  # 既存チャンネルへの自動収集一括有効化
  batch-import.ts        # 過去メッセージ一括取り込み
  clear-redis-keys.ts    # Redis キー確認・削除
vercel.json              # Vercel Cron スケジュール（UTC 0:00 = JST 9:00）
.env.local.example       # 環境変数テンプレート
```

---

## 今後の拡張予定

### X (Twitter) URL からの情報取得

現在は認証必須・ボット検知リスクのため除外しているが、以下の方法で対応予定：

| アプローチ | 内容 |
|-----------|------|
| Playwright ローカルスクリプト | ブラウザ操作でログイン済みセッションを利用してツイート本文を取得。バッチ実行向き |
| Twitter API v2 | Basic プラン以上で利用可能。`GET /2/tweets/:id` でツイート本文・メディアを取得し、extractor.ts に統合 |

いずれの方式でも、取得したテキストを `fullText` に追記する形で `extractor.ts` の `buildEnrichment()` に組み込む設計を想定。

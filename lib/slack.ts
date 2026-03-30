import { WebClient } from '@slack/web-api'
import { createHmac, timingSafeEqual } from 'crypto'
import type { CategoryLabel, SlackMessage } from '@/types/knowledge'
import { CATEGORY_EMOJI } from '@/types/knowledge'
import type { SlackFile } from '@/lib/extractor'

let _slackClient: WebClient | null = null
function getSlackClient(): WebClient {
  if (!_slackClient) _slackClient = new WebClient(process.env.SLACK_BOT_TOKEN)
  return _slackClient
}

// 署名検証
export function verifySlackSignature(
  signature: string,
  timestamp: string,
  rawBody: string
): boolean {
  const signingSecret = process.env.SLACK_SIGNING_SECRET!

  // タイムスタンプが5分以上古い場合は拒否
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false

  const baseString = `v0:${timestamp}:${rawBody}`
  const expected = 'v0=' + createHmac('sha256', signingSecret).update(baseString).digest('hex')

  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  } catch {
    return false
  }
}

// スレッド全文取得
export async function fetchThreadMessages(
  channelId: string,
  threadTs: string
): Promise<SlackMessage[]> {
  const result = await getSlackClient().conversations.replies({
    channel: channelId,
    ts: threadTs,
  })

  return (result.messages ?? []).map((m: { user?: string; text?: string; ts?: string }) => ({
    user: m.user ?? 'unknown',
    text: m.text ?? '',
    ts: m.ts ?? '',
  }))
}

// 投稿者の表示名を取得
export async function getUserDisplayName(userId: string): Promise<string> {
  try {
    const result = await getSlackClient().users.info({ user: userId })
    return result.user?.profile?.display_name || result.user?.real_name || userId
  } catch {
    return userId
  }
}

// チャンネル名を取得（DM・グループDM にも対応）
export async function getChannelName(channelId: string): Promise<string> {
  try {
    const result = await getSlackClient().conversations.info({ channel: channelId })
    const ch = result.channel as Record<string, unknown> | undefined
    if (ch?.is_im) return 'DM'
    if (ch?.is_mpim) return 'グループDM'
    return '#' + (ch?.name ?? channelId)
  } catch {
    return channelId
  }
}

// 元メッセージの Slack 添付ファイル一覧を取得
export async function fetchMessageFiles(
  channelId: string,
  messageTs: string
): Promise<SlackFile[]> {
  try {
    const result = await getSlackClient().conversations.history({
      channel: channelId,
      oldest: messageTs,
      latest: messageTs,
      limit: 1,
      inclusive: true,
    })
    const msg = result.messages?.[0] as Record<string, unknown> | undefined
    if (!msg?.files) return []
    const files = msg.files as Array<Record<string, string>>
    return files
      .filter((f) => f.url_private_download && f.mimetype)
      .map((f) => ({
        urlPrivateDownload: f.url_private_download,
        mimetype: f.mimetype,
        name: f.name ?? 'file',
      }))
  } catch {
    return []
  }
}

// 保存完了通知をスレッドへ返信
export async function postSaveNotification(
  channelId: string,
  threadTs: string,
  category: CategoryLabel,
  notionPageUrl: string
): Promise<void> {
  const emoji = CATEGORY_EMOJI[category]

  await getSlackClient().chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: `✅ Notion に保存しました（カテゴリ: ${emoji} ${category}）`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '✅ *Notion に保存しました*',
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `カテゴリ: ${emoji} ${category}　｜　<${notionPageUrl}|ページを開く>`,
          },
        ],
      },
    ],
  })
}

// ─── フェーズ4: データ収集関連メッセージ ───

// チャンネル参加時の確認メッセージ（ボタン付き）
export async function postCollectConfirmation(channelId: string): Promise<void> {
  await getSlackClient().chat.postMessage({
    channel: channelId,
    text: 'このチャンネルの過去のメッセージをすべて保存しますか？',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '📥 *このチャンネルの過去のメッセージをすべて保存しますか？*',
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'はい' },
            style: 'primary',
            action_id: 'collect_yes',
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'いいえ' },
            action_id: 'collect_no',
          },
        ],
      },
    ],
  })
}

// ボタン押下後にメッセージを更新（ボタンを除去してテキストに置き換え）
export async function updateCollectMessage(
  channelId: string,
  messageTs: string,
  text: string
): Promise<void> {
  await getSlackClient().chat.update({
    channel: channelId,
    ts: messageTs,
    text,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text },
      },
    ],
  })
}

// 収集完了通知
export async function postCollectComplete(channelId: string, count: number): Promise<void> {
  await getSlackClient().chat.postMessage({
    channel: channelId,
    text: `✅ 収集完了: ${count} 件のメッセージを保存しました。`,
  })
}

// ─── フェーズ6: タスク管理 ───

// タスク候補確認メッセージ（ボタン付き）
// 返り値: 送信したメッセージの ts
export async function postTaskConfirmation(
  channelId: string,
  previewText: string
): Promise<string> {
  const preview = previewText.length > 40 ? previewText.slice(0, 40) + '…' : previewText
  const result = await getSlackClient().chat.postMessage({
    channel: channelId,
    text: `📌 このメッセージをタスクに追加しますか？\n> ${preview}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `📌 *このメッセージをタスクに追加しますか？*\n> ${preview}`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'タスクに追加' },
            style: 'primary',
            action_id: 'task_confirm_yes',
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'スキップ' },
            action_id: 'task_confirm_no',
          },
        ],
      },
    ],
  })
  return result.ts as string
}

// 確認メッセージをテキストのみに更新（ボタン除去）
export async function updateTaskMessage(
  channelId: string,
  messageTs: string,
  text: string
): Promise<void> {
  await getSlackClient().chat.update({
    channel: channelId,
    ts: messageTs,
    text,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
  })
}

// 日付ピッカーメッセージ（期日未検出時）
// 返り値: 送信したメッセージの ts
export async function showDatePickerMessage(
  channelId: string,
  messageTs: string,
  previewText: string
): Promise<void> {
  const preview = previewText.length > 40 ? previewText.slice(0, 40) + '…' : previewText
  const tomorrow = new Date(Date.now() + 9 * 3600 * 1000 + 86400 * 1000).toISOString().slice(0, 10)

  await getSlackClient().chat.update({
    channel: channelId,
    ts: messageTs,
    text: `📅 いつまでにやりますか？\n> ${preview}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `📅 *いつまでにやりますか？*\n> ${preview}`,
        },
      },
      {
        type: 'actions',
        block_id: 'date_block',
        elements: [
          {
            type: 'datepicker',
            action_id: 'task_date_picker',
            initial_date: tomorrow,
            placeholder: { type: 'plain_text', text: '日付を選択' },
          },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'この日付で登録' },
            style: 'primary',
            action_id: 'task_date_confirm',
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '日付なしで登録' },
            action_id: 'task_no_date',
          },
        ],
      },
    ],
  })
}

// タスク登録完了通知
export async function postTaskRegistered(
  channelId: string,
  userId: string,
  title: string,
  notionUrl: string,
  dueDate?: string
): Promise<void> {
  const dueLine = dueDate
    ? `期日: ${dueDate.slice(5).replace('-', '/')}（${dueDate}）`
    : '期日なし'

  await getSlackClient().chat.postMessage({
    channel: channelId,
    text: `✅ タスクに登録しました（${dueLine}）`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `✅ *タスクに登録しました*（${dueLine}）\n<@${userId}> さんの担当として Notion に保存しました。`,
        },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `<${notionUrl}|Notion で開く>　｜　${title}` }],
      },
    ],
  })
}

// リマインダー通知
export async function postTaskReminder(
  channelId: string,
  userId: string,
  title: string,
  dueDate: string,
  notionUrl: string,
  type: '2d' | '1d' | '0d'
): Promise<void> {
  const dateLabel = dueDate.slice(5).replace('-', '/')
  const { emoji, label } = {
    '2d': { emoji: '⏰', label: `期限2日前（${dateLabel} まで）` },
    '1d': { emoji: '⚠️', label: '期限は明日' },
    '0d': { emoji: '🔴', label: '本日期限（今日中！）' },
  }[type]

  await getSlackClient().chat.postMessage({
    channel: channelId,
    text: `${emoji} <@${userId}> ${label}: ${title}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji} <@${userId}> *${label}*\n${title}`,
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'Notion で開く' },
          url: notionUrl,
          action_id: 'notion_link',
        },
      },
    ],
  })
}

// タスク完了通知
export async function postTaskComplete(
  channelId: string,
  userId: string,
  title: string,
  notionUrl: string
): Promise<void> {
  await getSlackClient().chat.postMessage({
    channel: channelId,
    text: `✅ タスク完了: ${title}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `✅ *タスク完了*: ${title}\n<@${userId}> さんが完了しました。お疲れ様でした！`,
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'Notion で開く' },
          url: notionUrl,
          action_id: 'notion_link',
        },
      },
    ],
  })
}

// 使い方ヒントをスレッドへ返信
export async function postUsageHint(
  channelId: string,
  threadTs: string
): Promise<void> {
  await getSlackClient().chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: '使い方: `@knowledgeBot <質問内容>` と話しかけてください',
  })
}

// RAG 回答をスレッドへ返信（出典リンク付き）
export async function postAnswer(
  channelId: string,
  threadTs: string,
  answer: string,
  sources: import('@/types/knowledge').VectorSearchResult[]
): Promise<void> {
  const sourceLines = sources
    .map((r) => {
      const m = r.metadata
      const savedDate = m.savedAt.slice(0, 10)
      return `・${m.title} (${m.channel} / ${savedDate})　<${m.notionUrl}|開く>`
    })
    .join('\n')

  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: answer } },
    ...(sourceLines
      ? [
          { type: 'divider' },
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: `*参照したナレッジ*
${sourceLines}` }],
          },
        ]
      : []),
  ]

  await getSlackClient().chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: answer,
    blocks,
  })
}

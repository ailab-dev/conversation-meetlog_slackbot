export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { Client as QStashClient } from '@upstash/qstash'
import { verifySlackSignature } from '@/lib/slack'
import {
  updateCollectMessage,
  updateTaskMessage,
  showDatePickerMessage,
  postTaskRegistered,
} from '@/lib/slack'
import { isCollecting, setCollecting, clearCollecting } from '@/lib/redis'
import {
  getPendingTask, deletePendingTask,
  getDatePendingTask, deleteDataPendingTask, setDatePendingTask,
  setTaskMeta, setTaskChannel, setTaskUser,
} from '@/lib/redis'
import { updateKnowledgePage } from '@/lib/notion'
import { extractDueDate } from '@/lib/task'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text()

  // Slack 署名検証
  const signature = req.headers.get('x-slack-signature') ?? ''
  const timestamp = req.headers.get('x-slack-request-timestamp') ?? ''
  if (!verifySlackSignature(signature, timestamp, rawBody)) {
    return NextResponse.json({ error: 'invalid_signature' }, { status: 403 })
  }

  // application/x-www-form-urlencoded をパース
  const params  = new URLSearchParams(rawBody)
  const payload = JSON.parse(params.get('payload') ?? '{}')

  const actionId   = payload.actions?.[0]?.action_id as string | undefined
  const channelId  = payload.channel?.id as string
  const messageTs  = payload.message?.ts as string

  if (!actionId || !channelId || !messageTs) {
    return NextResponse.json({ ok: true })
  }

  // ─── フェーズ4: 一括収集 ───
  if (actionId === 'collect_yes') {
    if (await isCollecting(channelId)) {
      await updateCollectMessage(channelId, messageTs, '⚠️ 現在収集中です。完了までお待ちください。')
      return NextResponse.json({ ok: true })
    }

    await setCollecting(channelId)
    await updateCollectMessage(channelId, messageTs, '📥 収集を開始しました。完了後に通知します。')

    const qstash = new QStashClient({
      token: process.env.QSTASH_TOKEN!,
      ...(process.env.QSTASH_URL ? { baseUrl: process.env.QSTASH_URL } : {}),
    })
    const baseUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : process.env.NEXT_PUBLIC_BASE_URL!

    try {
      await qstash.publishJSON({
        url: `${baseUrl}/api/slack/collect`,
        body: { channelId, cursor: null, collected: 0 },
      })
    } catch (err) {
      console.error('[QStash] publish error:', err)
      await clearCollecting(channelId)
      await updateCollectMessage(channelId, messageTs, '⚠️ 収集の開始に失敗しました。再度お試しください。')
    }

  } else if (actionId === 'collect_no') {
    await updateCollectMessage(channelId, messageTs, 'キャンセルしました。')

  // ─── フェーズ6: タスク管理 ───
  } else if (actionId === 'task_confirm_yes') {
    const pending = await getPendingTask(channelId, messageTs)
    if (!pending) {
      console.warn(`[Task] pending not found: channelId=${channelId} messageTs=${messageTs}`)
      return NextResponse.json({ ok: true })
    }
    await deletePendingTask(channelId, messageTs)
    await updateTaskMessage(channelId, messageTs, '⏳ 期日を確認中...')

    const dueDate = await extractDueDate(pending.rawText)
    if (dueDate) {
      await registerTask(channelId, messageTs, pending.notionPageId, pending.rawText, pending.userId, pending.originalTs, dueDate)
    } else {
      // 期日未検出 → 日付ピッカー表示
      await showDatePickerMessage(channelId, messageTs, pending.rawText)
      await setDatePendingTask(channelId, messageTs, {
        notionPageId: pending.notionPageId,
        userId: pending.userId,
        originalTs: pending.originalTs,
        rawText: pending.rawText,
        notionUrl: '',
        title: pending.rawText.slice(0, 80),
      })
    }

  } else if (actionId === 'task_confirm_no') {
    await updateTaskMessage(channelId, messageTs, 'スキップしました。')

  } else if (actionId === 'task_date_confirm') {
    const selectedDate = (payload.state?.values?.date_block?.task_date_picker?.selected_date as string | undefined)
    const pending = await getDatePendingTask(channelId, messageTs)
    if (!pending) return NextResponse.json({ ok: true })
    await deleteDataPendingTask(channelId, messageTs)
    await registerTask(channelId, messageTs, pending.notionPageId, pending.rawText, pending.userId, pending.originalTs, selectedDate)

  } else if (actionId === 'task_no_date') {
    const pending = await getDatePendingTask(channelId, messageTs)
    if (!pending) return NextResponse.json({ ok: true })
    await deleteDataPendingTask(channelId, messageTs)
    await registerTask(channelId, messageTs, pending.notionPageId, pending.rawText, pending.userId, pending.originalTs, undefined)
  }

  return NextResponse.json({ ok: true })
}

// ─── ヘルパー ───

async function registerTask(
  channelId: string,
  messageTs: string,
  notionPageId: string,
  rawText: string,
  userId: string,
  originalTs: string,
  dueDate: string | undefined
): Promise<void> {
  try {
    const result = await updateKnowledgePage(notionPageId, {
      category: 'タスク',
      ...(dueDate ? { dueDate } : {}),
    })

    // Notion URL を取得（pages.retrieve で url を得る）
    const { Client } = await import('@notionhq/client')
    const notion = new Client({ auth: process.env.NOTION_TOKEN })
    const page = await notion.pages.retrieve({ page_id: notionPageId })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const notionUrl = (page as any).url as string
    const title = rawText.slice(0, 80)

    // Redis にメタ情報を保存
    await setTaskMeta(channelId, originalTs, { notionPageId, notionUrl, title })
    await setTaskChannel(notionPageId, channelId)
    await setTaskUser(notionPageId, userId)

    await updateTaskMessage(channelId, messageTs, '✅ タスクに登録しました')
    await postTaskRegistered(channelId, userId, title, notionUrl, dueDate)

    void result
  } catch (err) {
    console.error('[Task] registerTask error:', err)
    await updateTaskMessage(channelId, messageTs, '⚠️ タスク登録に失敗しました。')
  }
}


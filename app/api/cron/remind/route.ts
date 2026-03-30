export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { queryTasksDueSoon } from '@/lib/notion'
import { getTaskChannel, getTaskUser, isReminderSent, markReminderSent } from '@/lib/redis'
import { postTaskReminder } from '@/lib/slack'

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Vercel Cron の認証チェック
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // JST での今日の日付
  const todayJST = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)

  let tasks
  try {
    tasks = await queryTasksDueSoon()
  } catch (err) {
    console.error('[Cron] queryTasksDueSoon error:', err)
    return NextResponse.json({ error: 'notion_query_failed' }, { status: 500 })
  }

  let sent = 0
  let skipped = 0

  for (const task of tasks) {
    const daysUntil = diffDays(todayJST, task.dueDate)
    if (daysUntil < 0 || daysUntil > 2) continue

    const type = daysUntil === 0 ? '0d' : daysUntil === 1 ? '1d' : '2d'

    if (await isReminderSent(task.id, type)) {
      skipped++
      continue
    }

    const channelId = await getTaskChannel(task.id)
    const userId = await getTaskUser(task.id)

    if (!channelId || !userId) {
      console.warn(`[Cron] task ${task.id} missing channel/user, skipping`)
      skipped++
      continue
    }

    try {
      await postTaskReminder(channelId, userId, task.title, task.dueDate, task.notionUrl, type)
      await markReminderSent(task.id, type)
      sent++
    } catch (err) {
      console.error(`[Cron] postTaskReminder error for ${task.id}:`, err)
    }
  }

  console.log(`[Cron] remind complete: sent=${sent}, skipped=${skipped}`)
  return NextResponse.json({ ok: true, sent, skipped })
}

/** YYYY-MM-DD 形式の2つの日付の差（日数）を返す。b - a */
function diffDays(a: string, b: string): number {
  const msA = new Date(a).getTime()
  const msB = new Date(b).getTime()
  return Math.round((msB - msA) / 86400000)
}

import { Redis } from '@upstash/redis'

const TTL_SECONDS = 60 * 60 * 24 * 30 // 30日

let _redis: Redis | null = null
function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    })
  }
  return _redis
}

export function buildRedisKey(channelId: string, messageTs: string, reaction: string): string {
  return `knowledge:${channelId}:${messageTs}:${reaction}`
}

export async function isDuplicate(key: string): Promise<boolean> {
  try {
    const exists = await getRedis().exists(key)
    return exists === 1
  } catch (err) {
    console.error('[Redis] isDuplicate error:', err)
    return true
  }
}

export async function markAsProcessed(key: string): Promise<void> {
  try {
    await getRedis().set(key, '1', { ex: TTL_SECONDS })
  } catch (err) {
    console.error('[Redis] markAsProcessed error:', err)
  }
}

// ─── フェーズ5: Notion ページID キャッシュ（スレッド返信追記用）───

function notionTsKey(channelId: string, ts: string): string {
  return `notion_ts:${channelId}:${ts}`
}

export async function getNotionPageId(channelId: string, ts: string): Promise<string | null> {
  try {
    return await getRedis().get<string>(notionTsKey(channelId, ts))
  } catch {
    return null
  }
}

export async function setNotionPageId(channelId: string, ts: string, pageId: string): Promise<void> {
  try {
    await getRedis().set(notionTsKey(channelId, ts), pageId, { ex: TTL_SECONDS })
  } catch (err) {
    console.error('[Redis] setNotionPageId error:', err)
  }
}

// ─── フェーズ5: 自動収集モード ───

function autoCollectKey(channelId: string): string {
  return `autocollect:${channelId}`
}

export async function isAutoCollect(channelId: string): Promise<boolean> {
  try {
    return (await getRedis().exists(autoCollectKey(channelId))) === 1
  } catch {
    return false
  }
}

export async function setAutoCollect(channelId: string): Promise<void> {
  try {
    await getRedis().set(autoCollectKey(channelId), '1')
  } catch (err) {
    console.error('[Redis] setAutoCollect error:', err)
  }
}

// ─── フェーズ6: タスク管理 ───

export interface PendingTask {
  notionPageId: string
  rawText: string
  userId: string
  originalTs: string
}

export interface DatePendingTask {
  notionPageId: string
  userId: string
  originalTs: string
  rawText: string
  notionUrl: string
  title: string
}

export interface TaskMeta {
  notionPageId: string
  notionUrl: string
  title: string
}

const TASK_TTL = 60 * 60 * 24 * 90   // 90日
const PENDING_TTL = 60 * 60 * 24 * 3  // 3日
const REMINDER_TTL = 60 * 60 * 24 * 5 // 5日

// タスク追加確認ボタン待ち
export async function setPendingTask(channelId: string, confirmMsgTs: string, data: PendingTask): Promise<void> {
  try {
    await getRedis().set(`task_pending:${channelId}:${confirmMsgTs}`, data, { ex: PENDING_TTL })
  } catch (err) {
    console.error('[Redis] setPendingTask error:', err)
  }
}

export async function getPendingTask(channelId: string, confirmMsgTs: string): Promise<PendingTask | null> {
  try {
    return await getRedis().get<PendingTask>(`task_pending:${channelId}:${confirmMsgTs}`)
  } catch {
    return null
  }
}

export async function deletePendingTask(channelId: string, confirmMsgTs: string): Promise<void> {
  try {
    await getRedis().del(`task_pending:${channelId}:${confirmMsgTs}`)
  } catch { /* ignore */ }
}

// 日付ピッカー待ち（期日未検出時）
export async function setDatePendingTask(channelId: string, dateMsgTs: string, data: DatePendingTask): Promise<void> {
  try {
    await getRedis().set(`task_date_pending:${channelId}:${dateMsgTs}`, data, { ex: PENDING_TTL })
  } catch (err) {
    console.error('[Redis] setDatePendingTask error:', err)
  }
}

export async function getDatePendingTask(channelId: string, dateMsgTs: string): Promise<DatePendingTask | null> {
  try {
    return await getRedis().get<DatePendingTask>(`task_date_pending:${channelId}:${dateMsgTs}`)
  } catch {
    return null
  }
}

export async function deleteDataPendingTask(channelId: string, dateMsgTs: string): Promise<void> {
  try {
    await getRedis().del(`task_date_pending:${channelId}:${dateMsgTs}`)
  } catch { /* ignore */ }
}

// タスク登録済みメタ（完了検知・リマインダー用）
export async function setTaskMeta(channelId: string, originalMsgTs: string, data: TaskMeta): Promise<void> {
  try {
    await getRedis().set(`task_meta:${channelId}:${originalMsgTs}`, data, { ex: TASK_TTL })
  } catch (err) {
    console.error('[Redis] setTaskMeta error:', err)
  }
}

export async function getTaskMeta(channelId: string, originalMsgTs: string): Promise<TaskMeta | null> {
  try {
    return await getRedis().get<TaskMeta>(`task_meta:${channelId}:${originalMsgTs}`)
  } catch {
    return null
  }
}

// リマインダー送信先チャンネル
export async function setTaskChannel(notionPageId: string, channelId: string): Promise<void> {
  try {
    await getRedis().set(`task_channel:${notionPageId}`, channelId, { ex: TASK_TTL })
  } catch (err) {
    console.error('[Redis] setTaskChannel error:', err)
  }
}

export async function getTaskChannel(notionPageId: string): Promise<string | null> {
  try {
    return await getRedis().get<string>(`task_channel:${notionPageId}`)
  } catch {
    return null
  }
}

// @メンション用ユーザー ID
export async function setTaskUser(notionPageId: string, slackUserId: string): Promise<void> {
  try {
    await getRedis().set(`task_user:${notionPageId}`, slackUserId, { ex: TASK_TTL })
  } catch (err) {
    console.error('[Redis] setTaskUser error:', err)
  }
}

export async function getTaskUser(notionPageId: string): Promise<string | null> {
  try {
    return await getRedis().get<string>(`task_user:${notionPageId}`)
  } catch {
    return null
  }
}

// リマインダー重複送信防止
export async function isReminderSent(notionPageId: string, type: '2d' | '1d' | '0d'): Promise<boolean> {
  try {
    return (await getRedis().exists(`reminder_sent:${notionPageId}:${type}`)) === 1
  } catch {
    return false
  }
}

export async function markReminderSent(notionPageId: string, type: '2d' | '1d' | '0d'): Promise<void> {
  try {
    await getRedis().set(`reminder_sent:${notionPageId}:${type}`, '1', { ex: REMINDER_TTL })
  } catch (err) {
    console.error('[Redis] markReminderSent error:', err)
  }
}

// ─── フェーズ4: チャンネル収集中フラグ ───

function collectingKey(channelId: string): string {
  return `collecting:${channelId}`
}

export async function isCollecting(channelId: string): Promise<boolean> {
  try {
    return (await getRedis().exists(collectingKey(channelId))) === 1
  } catch {
    return false
  }
}

export async function setCollecting(channelId: string, ttlSeconds = 7200): Promise<void> {
  try {
    await getRedis().set(collectingKey(channelId), '1', { ex: ttlSeconds })
  } catch (err) {
    console.error('[Redis] setCollecting error:', err)
  }
}

export async function clearCollecting(channelId: string): Promise<void> {
  try {
    await getRedis().del(collectingKey(channelId))
  } catch (err) {
    console.error('[Redis] clearCollecting error:', err)
  }
}

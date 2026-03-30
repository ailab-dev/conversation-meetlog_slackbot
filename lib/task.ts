/**
 * フェーズ6: タスク検知・期日抽出
 */

import { GoogleGenerativeAI } from '@google/generative-ai'

function getGenAI(): GoogleGenerativeAI {
  return new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)
}

const TASK_KEYWORDS = [
  'タスク', 'todo', 'ToDo', 'TODO', 'to-do', 'To-Do', 'TO-DO',
  'やること', 'やる事', 'やっておく', 'やっておいて',
  'までに', 'までには', '期限', '締め切り', 'デッドライン', 'deadline',
  'する必要', 'してください', 'お願いします', 'お願いいたします',
  '対応してください', '対応お願い', 'を忘れずに',
]

const COMPLETION_KEYWORDS = [
  '完了', '対応しました', 'やりました', '終わりました', '終了しました',
  'できました', '済みです', '対応済み', 'done', 'finished', 'completed',
]

export function detectTaskKeywords(text: string): boolean {
  const lower = text.toLowerCase()
  return TASK_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()))
}

export function detectCompletionKeywords(text: string): boolean {
  const lower = text.toLowerCase()
  return COMPLETION_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()))
}

/**
 * Gemini でメッセージ本文から期日を抽出する。
 * @returns YYYY-MM-DD 形式の文字列、見つからなければ undefined
 */
export async function extractDueDate(text: string): Promise<string | undefined> {
  // JST での今日の日付
  const todayJST = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)

  const model = getGenAI().getGenerativeModel({ model: 'gemini-2.5-flash' })
  const prompt = `今日は${todayJST}（JST）です。
以下のSlackメッセージから期限・締め切り・実施予定日を抽出してください。
「今日」「明日」「来週月曜」「3/31」「3月31日」などをYYYY-MM-DD形式に変換してください。
期限が見つからない場合は null を返してください。
必ずJSON形式のみで返してください（説明文不要）: {"dueDate": "YYYY-MM-DD"} または {"dueDate": null}

メッセージ: ${text}`

  try {
    const result = await model.generateContent(prompt)
    const raw = result.response.text().trim()
    // Markdownコードブロックを除去
    const json = raw.replace(/^```json?\n?/i, '').replace(/\n?```$/, '').trim()
    const parsed = JSON.parse(json) as { dueDate: string | null }
    return parsed.dueDate ?? undefined
  } catch {
    return undefined
  }
}

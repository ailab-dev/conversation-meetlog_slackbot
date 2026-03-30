import { Client } from '@notionhq/client'
import type { KnowledgeData } from '@/types/knowledge'

export async function createKnowledgePage(
  data: KnowledgeData
): Promise<{ id: string; url: string }> {
  const notion = new Client({ auth: process.env.NOTION_TOKEN })
  const response = await notion.pages.create({
    parent: { database_id: process.env.NOTION_DATABASE_ID! },
    properties: {
      Title: {
        title: [{ text: { content: data.title } }],
      },
      Category: {
        select: { name: data.category },
      },
      PostedBy: {
        rich_text: [{ text: { content: data.postedBy } }],
      },
      SlackChannel: {
        rich_text: [{ text: { content: data.slackChannel } }],
      },
      SavedAt: {
        date: { start: data.savedAt },
      },
    },
    children: (() => {
      const chunks: string[] = []
      for (let i = 0; i < data.fullText.length; i += 1900) {
        chunks.push(data.fullText.slice(i, i + 1900))
      }
      if (chunks.length === 0) chunks.push('')
      return chunks.map((chunk) => ({
        object: 'block' as const,
        type: 'paragraph' as const,
        paragraph: { rich_text: [{ text: { content: chunk } }] },
      }))
    })(),
  })

  return {
    id: response.id,
    url: (response as { url: string }).url,
  }
}

// ─── フェーズ6: タスク管理 ───

export async function updateKnowledgePage(
  pageId: string,
  patch: { category?: string; dueDate?: string }
): Promise<void> {
  const notion = new Client({ auth: process.env.NOTION_TOKEN })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const properties: Record<string, any> = {}
  if (patch.category !== undefined) {
    properties['Category'] = { select: { name: patch.category } }
  }
  if (patch.dueDate !== undefined) {
    properties['DueDate'] = { date: { start: patch.dueDate } }
  }
  if (Object.keys(properties).length === 0) return
  await notion.pages.update({ page_id: pageId, properties })
}

export interface TaskRecord {
  id: string
  title: string
  dueDate: string
  notionUrl: string
}

export async function queryTasksDueSoon(): Promise<TaskRecord[]> {
  const notion = new Client({ auth: process.env.NOTION_TOKEN })

  const todayJST = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
  const twoDaysLaterJST = new Date(Date.now() + 9 * 3600 * 1000 + 2 * 86400 * 1000).toISOString().slice(0, 10)

  const response = await notion.databases.query({
    database_id: process.env.NOTION_DATABASE_ID!,
    filter: {
      and: [
        { property: 'Category', select: { equals: 'タスク' } },
        { property: 'DueDate', date: { on_or_after: todayJST } },
        { property: 'DueDate', date: { on_or_before: twoDaysLaterJST } },
      ],
    },
  })

  return response.results
    .map((page) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = page as any
      const titleArr = p.properties?.Title?.title as Array<{ plain_text: string }> | undefined
      const title = titleArr?.[0]?.plain_text ?? '（タイトルなし）'
      const dueDate = (p.properties?.DueDate?.date?.start as string | undefined) ?? ''
      const notionUrl = (p.url as string | undefined) ?? ''
      return { id: p.id as string, title, dueDate, notionUrl }
    })
    .filter((r) => r.dueDate !== '')
}

export async function appendToKnowledgePage(pageId: string, text: string): Promise<void> {
  const notion = new Client({ auth: process.env.NOTION_TOKEN })
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += 1900) {
    chunks.push(text.slice(i, i + 1900))
  }
  if (chunks.length === 0) return
  await notion.blocks.children.append({
    block_id: pageId,
    children: chunks.map((chunk) => ({
      object: 'block' as const,
      type: 'paragraph' as const,
      paragraph: { rich_text: [{ text: { content: chunk } }] },
    })),
  })
}

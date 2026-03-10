/**
 * knowledge:* パターンに一致するRedisキーを全件削除するスクリプト
 *
 * 使用例（全件削除）:
 *   npx tsx scripts/clear-redis-keys.ts
 *
 * --dry-run で確認のみ:
 *   npx tsx scripts/clear-redis-keys.ts --dry-run
 */

import * as dotenv from 'dotenv'
import * as path from 'path'
import { Redis } from '@upstash/redis'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

const DRY_RUN = process.argv.includes('--dry-run')

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
})

async function main() {
  console.log(`=== Redis キー削除 ${DRY_RUN ? '[DRY RUN]' : ''} ===\n`)

  // SCAN で knowledge:* を全件取得
  let cursor = 0
  const keys: string[] = []
  do {
    const [nextCursor, batch] = await redis.scan(cursor, { match: 'knowledge:*', count: 100 })
    keys.push(...batch)
    cursor = Number(nextCursor)
  } while (cursor !== 0)

  console.log(`対象キー数: ${keys.length} 件`)
  keys.forEach((k) => console.log(' ', k))

  if (DRY_RUN || keys.length === 0) {
    if (DRY_RUN) console.log('\n--dry-run のため削除しません。')
    return
  }

  let deleted = 0
  for (const key of keys) {
    await redis.del(key)
    deleted++
  }
  console.log(`\n削除完了: ${deleted} 件`)
}

main().catch((err) => {
  console.error('エラー:', err)
  process.exit(1)
})

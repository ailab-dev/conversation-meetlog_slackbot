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

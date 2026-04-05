export interface ApiResponse<T> {
    data: T
    cached: boolean
    cachedAt: string | null
    stale: boolean
}

let redisClient: any = null
let redisResolved = false

async function getRedisClient() {
    if (redisResolved) return redisClient
    redisResolved = true
    try {
        const { getRedis } = await import('../redis-client.js')
        redisClient = await getRedis()
        return redisClient
    } catch {
        return null
    }
}

export async function cachedFetch<T>(
    cacheKey: string,
    ttlSeconds: number,
    fetcher: () => Promise<T>,
): Promise<ApiResponse<T>> {
    const redis = await getRedisClient()

    if (redis) {
        try {
            const cached = await redis.get(cacheKey)
            if (cached) {
                const parsed = JSON.parse(cached) as { data: T; cachedAt: string }
                return { data: parsed.data, cached: true, cachedAt: parsed.cachedAt, stale: false }
            }
        } catch { /* cache miss */ }
    }

    const data = await fetcher()
    const cachedAt = new Date().toISOString()

    if (redis) {
        try { await redis.set(cacheKey, JSON.stringify({ data, cachedAt }), 'EX', ttlSeconds) } catch { /* non-fatal */ }
    }

    return { data, cached: false, cachedAt, stale: false }
}

export function freshResponse<T>(data: T): ApiResponse<T> {
    return { data, cached: false, cachedAt: new Date().toISOString(), stale: false }
}

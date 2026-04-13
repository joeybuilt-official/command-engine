import { createClient, type RedisClientType } from 'redis'
import pino from 'pino'

const logger = pino({ name: 'redis-client' })

let _redis: RedisClientType | null = null

export async function getRedis(): Promise<RedisClientType> {
    if (_redis?.isReady) return _redis

    // Close stale client if it exists but isn't ready
    if (_redis) {
        try { await _redis.disconnect() } catch { /* ok */ }
        _redis = null
    }

    _redis = createClient({
        url: process.env.REDIS_URL ?? 'redis://localhost:6379',
        socket: {
            reconnectStrategy(retries: number) {
                if (retries > 20) {
                    logger.error({ retries }, 'Redis reconnect limit reached — giving up')
                    return new Error('Redis reconnect limit reached')
                }
                // Exponential backoff: 100ms, 200ms, 400ms ... capped at 10s
                const delay = Math.min(100 * Math.pow(2, retries), 10_000)
                logger.warn({ retries, delayMs: delay }, 'Redis reconnecting')
                return delay
            },
        },
    }) as RedisClientType

    _redis.on('error', (err: Error) => {
        logger.error({ err: err.message }, 'Redis client error')
    })

    _redis.on('reconnecting', () => {
        logger.info('Redis reconnecting')
    })

    await _redis.connect()
    logger.info('Redis connected')
    return _redis
}

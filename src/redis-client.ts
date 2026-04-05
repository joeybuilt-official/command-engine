import { createClient, type RedisClientType } from 'redis'
import pino from 'pino'

const logger = pino({ name: 'redis-client' })

let _redis: RedisClientType | null = null
let connecting = false

export async function getRedis(): Promise<RedisClientType> {
    if (_redis?.isReady) return _redis

    if (connecting) {
        const start = Date.now()
        while (connecting && Date.now() - start < 3000) {
            await new Promise((r) => setTimeout(r, 50))
        }
        if (_redis?.isReady) return _redis
        throw new Error('Redis connection timed out')
    }

    connecting = true
    try {
        _redis = createClient({
            url: process.env.REDIS_URL ?? 'redis://localhost:6379',
        }) as RedisClientType

        _redis.on('error', (err: Error) => {
            logger.error({ err }, 'Redis client error')
        })

        await _redis.connect()
        logger.info('Redis connected')
        return _redis
    } finally {
        connecting = false
    }
}

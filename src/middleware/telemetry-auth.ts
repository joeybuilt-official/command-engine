import type { Request, Response, NextFunction } from 'express'
import { timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Lightweight auth for telemetry ingestion.
 * Requires X-Instance-Id header (valid UUID).
 * If TELEMETRY_SERVICE_KEY is set, also requires X-Service-Key to match.
 */
export function telemetryIngestAuth(req: Request, res: Response, next: NextFunction): void {
    const instanceId = req.headers['x-instance-id'] as string | undefined

    if (!instanceId || !UUID_RE.test(instanceId)) {
        res.status(400).json({ error: { code: 'INVALID_INSTANCE', message: 'Valid X-Instance-Id header required' } })
        return
    }

    const requiredKey = process.env.TELEMETRY_SERVICE_KEY
    if (requiredKey) {
        const providedKey = req.headers['x-service-key'] as string | undefined
        if (!providedKey || !timingSafeEqual(providedKey, requiredKey)) {
            res.status(401).json({ error: { code: 'INVALID_KEY', message: 'Invalid X-Service-Key' } })
            return
        }
    }

    ;(req as unknown as Record<string, unknown>).instanceId = instanceId
    next()
}

function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    return cryptoTimingSafeEqual(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'))
}

import type { Request, Response, NextFunction } from 'express'
import { timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto'

/**
 * Command Engine auth middleware.
 * Service key auth only: Bearer token = PLEXO_SERVICE_KEY + X-App-Id: command-center.
 */
export async function cmdCenterAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing Bearer token' } })
        return
    }

    const token = authHeader.slice(7)
    const appId = req.headers['x-app-id'] as string | undefined
    const serviceKey = process.env.PLEXO_SERVICE_KEY

    if (!serviceKey) {
        res.status(500).json({ error: { code: 'CONFIG_ERROR', message: 'PLEXO_SERVICE_KEY not configured' } })
        return
    }

    if (appId !== 'command-center') {
        res.status(401).json({ error: { code: 'INVALID_APP', message: 'X-App-Id must be command-center' } })
        return
    }

    if (timingSafeEqual(token, serviceKey)) {
        req.user = {
            id: 'service:command-center',
            email: 'command-center@internal',
            role: 'admin',
            isSuperAdmin: true,
        }
        next()
        return
    }

    res.status(401).json({ error: { code: 'INVALID_KEY', message: 'Invalid service key' } })
}

function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    const bufA = Buffer.from(a, 'utf-8')
    const bufB = Buffer.from(b, 'utf-8')
    return cryptoTimingSafeEqual(bufA, bufB)
}

import { Router, type Router as RouterType } from 'express'
import { logger } from '../logger.js'

export const channelsRouter: RouterType = Router()

const PLEXO_API = process.env.PLEXO_API_URL ?? 'http://plexo-api:3001'
const SERVICE_KEY = process.env.PLEXO_SERVICE_KEY ?? ''
const ADMIN_USER_ID = process.env.PLEXO_ADMIN_USER_ID ?? ''

function plexoHeaders(): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        'X-Plexo-Service-Key': SERVICE_KEY,
        'X-Plexo-User-Id': ADMIN_USER_ID,
    }
}

// GET / — list channels for workspace
channelsRouter.get('/', async (req, res) => {
    const workspaceId = req.query.workspaceId as string
    if (!workspaceId) {
        res.status(400).json({ error: 'workspaceId required' })
        return
    }
    try {
        const upstream = await fetch(
            `${PLEXO_API}/api/v1/channels?workspaceId=${encodeURIComponent(workspaceId)}`,
            { headers: plexoHeaders(), signal: AbortSignal.timeout(10_000) },
        )
        const data = await upstream.json()
        res.status(upstream.status).json(data)
    } catch (err) {
        logger.error({ err }, 'cmd-center: channels proxy failed')
        res.status(502).json({ error: 'Failed to reach Plexo API' })
    }
})

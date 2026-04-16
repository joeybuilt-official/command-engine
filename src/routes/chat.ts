import { Router, type Router as RouterType } from 'express'
import { logger } from '../logger.js'

export const chatRouter: RouterType = Router()

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

// POST /message — proxy chat message to Plexo
chatRouter.post('/message', async (req, res) => {
    try {
        const upstream = await fetch(
            `${PLEXO_API}/api/v1/chat/message`,
            {
                method: 'POST',
                headers: plexoHeaders(),
                body: JSON.stringify(req.body),
                signal: AbortSignal.timeout(60_000),
            },
        )
        const data = await upstream.json()
        res.status(upstream.status).json(data)
    } catch (err) {
        logger.error({ err }, 'cmd-center: chat message proxy failed')
        res.status(502).json({ error: 'Failed to reach Plexo API' })
    }
})

// GET /reply/:taskId — proxy task reply polling to Plexo
chatRouter.get('/reply/:taskId', async (req, res) => {
    const { taskId } = req.params
    try {
        const upstream = await fetch(
            `${PLEXO_API}/api/v1/chat/reply/${encodeURIComponent(taskId)}`,
            { headers: plexoHeaders(), signal: AbortSignal.timeout(60_000) },
        )
        const data = await upstream.json()
        res.status(upstream.status).json(data)
    } catch (err) {
        logger.error({ err }, 'cmd-center: chat reply proxy failed')
        res.status(502).json({ error: 'Failed to reach Plexo API' })
    }
})

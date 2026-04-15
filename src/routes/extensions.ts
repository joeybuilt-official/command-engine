import { Router, type Router as RouterType } from 'express'
import { logger } from '../logger.js'

export const extensionsRouter: RouterType = Router()

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

// GET / — list extensions for workspace
extensionsRouter.get('/', async (req, res) => {
    const workspaceId = req.query.workspaceId as string
    if (!workspaceId) {
        res.status(400).json({ error: 'workspaceId required' })
        return
    }
    try {
        const upstream = await fetch(
            `${PLEXO_API}/api/v1/extensions?workspaceId=${encodeURIComponent(workspaceId)}`,
            { headers: plexoHeaders(), signal: AbortSignal.timeout(10_000) },
        )
        const data = await upstream.json()
        res.status(upstream.status).json(data)
    } catch (err) {
        logger.error({ err }, 'cmd-center: extensions proxy failed')
        res.status(502).json({ error: 'Failed to reach Plexo API' })
    }
})

// PATCH /:id — toggle extension enabled
extensionsRouter.patch('/:id', async (req, res) => {
    const { id } = req.params
    try {
        const upstream = await fetch(
            `${PLEXO_API}/api/v1/extensions/${encodeURIComponent(id)}`,
            {
                method: 'PATCH',
                headers: plexoHeaders(),
                body: JSON.stringify(req.body),
                signal: AbortSignal.timeout(10_000),
            },
        )
        const data = await upstream.json()
        res.status(upstream.status).json(data)
    } catch (err) {
        logger.error({ err }, 'cmd-center: extension toggle proxy failed')
        res.status(502).json({ error: 'Failed to reach Plexo API' })
    }
})

// DELETE /:id — uninstall extension
extensionsRouter.delete('/:id', async (req, res) => {
    const { id } = req.params
    try {
        const upstream = await fetch(
            `${PLEXO_API}/api/v1/extensions/${encodeURIComponent(id)}`,
            {
                method: 'DELETE',
                headers: plexoHeaders(),
                signal: AbortSignal.timeout(10_000),
            },
        )
        const data = await upstream.json()
        res.status(upstream.status).json(data)
    } catch (err) {
        logger.error({ err }, 'cmd-center: extension uninstall proxy failed')
        res.status(502).json({ error: 'Failed to reach Plexo API' })
    }
})

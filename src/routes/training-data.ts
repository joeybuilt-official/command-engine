import { Router, type Router as RouterType } from 'express'
import { logger } from '../logger.js'

export const trainingDataRouter: RouterType = Router()

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

// GET /sources — list training data sources
trainingDataRouter.get('/sources', async (_req, res) => {
    try {
        const upstream = await fetch(
            `${PLEXO_API}/api/v1/admin/training-data/sources`,
            { headers: plexoHeaders(), signal: AbortSignal.timeout(10_000) },
        )
        const data = await upstream.json()
        res.status(upstream.status).json(data)
    } catch (err) {
        logger.error({ err }, 'cmd-center: training-data sources proxy failed')
        res.status(502).json({ error: 'Failed to reach Plexo API' })
    }
})

// GET /sources/:source/sample — sample training data
trainingDataRouter.get('/sources/:source/sample', async (req, res) => {
    const { source } = req.params
    const limit = req.query.limit || '5'
    try {
        const upstream = await fetch(
            `${PLEXO_API}/api/v1/admin/training-data/sources/${encodeURIComponent(source)}/sample?limit=${limit}`,
            { headers: plexoHeaders(), signal: AbortSignal.timeout(15_000) },
        )
        const data = await upstream.json()
        res.status(upstream.status).json(data)
    } catch (err) {
        logger.error({ err }, 'cmd-center: training-data sample proxy failed')
        res.status(502).json({ error: 'Failed to reach Plexo API' })
    }
})

// POST /export — export training data
trainingDataRouter.post('/export', async (req, res) => {
    try {
        const upstream = await fetch(
            `${PLEXO_API}/api/v1/admin/training-data/export`,
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
        logger.error({ err }, 'cmd-center: training-data export proxy failed')
        res.status(502).json({ error: 'Failed to reach Plexo API' })
    }
})

import { Router, type Router as RouterType } from 'express'
import { getHealthTimeline, getHealthState } from '../health-monitor.js'

export const healthTimelineRouter: RouterType = Router()

// GET /health/timeline — recent health transition events
healthTimelineRouter.get('/timeline', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200)
    try {
        const events = await getHealthTimeline(limit)
        res.json({ events })
    } catch (err: any) {
        res.status(500).json({ error: err?.message ?? 'Failed' })
    }
})

// GET /health/state — current health state of all monitored services
healthTimelineRouter.get('/state', async (_req, res) => {
    try {
        const state = await getHealthState()
        res.json({ state })
    } catch (err: any) {
        res.status(500).json({ error: err?.message ?? 'Failed' })
    }
})

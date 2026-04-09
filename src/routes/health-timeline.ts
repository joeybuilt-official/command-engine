// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Infrastructure Health Timeline API
 *
 * GET /health-timeline         — recent health state-change events (filterable)
 * GET /resource-metrics        — recent resource snapshots
 * GET /health-current          — live container status via docker ps
 */
import { Router, type Router as RouterType } from 'express'
import { execSync } from 'node:child_process'
import { db, sql, eq, desc } from '../db/index.js'
import { serviceHealthEvents, resourceMetrics } from '../db/schema.js'
import { logger } from '../logger.js'

export const healthTimelineRouter: RouterType = Router()

function exec(cmd: string, timeout = 10_000): string {
    return execSync(cmd, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 }).trim()
}

// GET /health-timeline — recent health events, filterable by service_name
healthTimelineRouter.get('/', async (req, res) => {
    const serviceName = req.query.service_name as string | undefined
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200)

    try {
        const query = serviceName
            ? db.select().from(serviceHealthEvents)
                .where(eq(serviceHealthEvents.serviceName, serviceName))
                .orderBy(desc(serviceHealthEvents.recordedAt))
                .limit(limit)
            : db.select().from(serviceHealthEvents)
                .orderBy(desc(serviceHealthEvents.recordedAt))
                .limit(limit)

        const events = await query
        res.json({ events, count: events.length })
    } catch (err: any) {
        logger.error({ err: err?.message }, 'Failed to fetch health timeline')
        res.status(500).json({ error: 'Failed to fetch health timeline' })
    }
})

// GET /resource-metrics — recent resource snapshots
healthTimelineRouter.get('/resource-metrics', async (req, res) => {
    const metricType = req.query.metric_type as string | undefined
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200)

    try {
        const query = metricType
            ? db.select().from(resourceMetrics)
                .where(eq(resourceMetrics.metricType, metricType))
                .orderBy(desc(resourceMetrics.recordedAt))
                .limit(limit)
            : db.select().from(resourceMetrics)
                .orderBy(desc(resourceMetrics.recordedAt))
                .limit(limit)

        const metrics = await query
        res.json({ metrics, count: metrics.length })
    } catch (err: any) {
        logger.error({ err: err?.message }, 'Failed to fetch resource metrics')
        res.status(500).json({ error: 'Failed to fetch resource metrics' })
    }
})

// GET /health-current — live docker ps status of all containers
healthTimelineRouter.get('/current', (_req, res) => {
    if (process.env.DOCKER_SOCKET_ENABLED !== 'true') {
        res.status(503).json({ error: 'Docker socket not enabled' })
        return
    }

    try {
        const raw = exec('docker ps -a --format json')
        const containers = raw
            .split('\n')
            .filter(Boolean)
            .map(line => {
                try { return JSON.parse(line) } catch { return null }
            })
            .filter(Boolean)
            .map((c: any) => {
                const state = c.State?.toLowerCase() ?? ''
                const status = c.Status?.toLowerCase() ?? ''

                let healthStatus: string
                if (state === 'running' && status.includes('(healthy)')) healthStatus = 'healthy'
                else if (state === 'running' && status.includes('(unhealthy)')) healthStatus = 'unhealthy'
                else if (state === 'running' && status.includes('starting')) healthStatus = 'starting'
                else if (state === 'running') healthStatus = 'healthy'
                else healthStatus = 'down'

                return {
                    name: c.Names,
                    status: healthStatus,
                    dockerState: c.State,
                    dockerStatus: c.Status,
                    image: c.Image,
                    ports: c.Ports ?? '',
                }
            })

        res.json({ containers, count: containers.length, timestamp: new Date().toISOString() })
    } catch (err: any) {
        logger.error({ err: err?.message }, 'Failed to get current health')
        res.status(500).json({ error: err?.message ?? 'Failed to get current container status' })
    }
})

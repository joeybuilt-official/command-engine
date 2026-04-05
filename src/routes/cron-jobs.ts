import { Router, type Router as RouterType } from 'express'
import { db, eq, desc } from '../db/index.js'
import { cronJobs } from '../db/index.js'
import { freshResponse } from './cache.js'
import { logger } from '../logger.js'

export const cronJobsRouter: RouterType = Router()

// System-level periodic tasks (not in DB — hardcoded system crons)
const SYSTEM_CRONS = [
    {
        id: 'system:health-monitor',
        name: 'Health Monitor',
        schedule: '* * * * *',
        enabled: true,
        system: true,
        description: 'Polls all services every 60s, records state transitions',
    },
    {
        id: 'system:cron-dispatch',
        name: 'Cron Dispatch Tick',
        schedule: '* * * * *',
        enabled: true,
        system: true,
        description: 'Checks cron_jobs table for due jobs every 60s',
    },
]

cronJobsRouter.get('/', async (_req, res) => {
    try {
        const wsId = process.env.CMD_CENTER_WORKSPACE_ID
        let dbJobs: typeof SYSTEM_CRONS extends (infer U)[] ? (U & { lastRunAt?: Date | null; lastRunStatus?: string | null; nextRunAt?: Date | null })[] : never[] = []

        if (wsId) {
            const rows = await db
                .select()
                .from(cronJobs)
                .where(eq(cronJobs.workspaceId, wsId))
                .orderBy(desc(cronJobs.createdAt))

            dbJobs = rows.map(r => ({
                id: r.id,
                name: r.name,
                schedule: r.schedule,
                enabled: r.enabled,
                system: false,
                description: '',
                lastRunAt: r.lastRunAt,
                lastRunStatus: r.lastRunStatus,
                nextRunAt: r.nextRunAt,
            }))
        }

        const all = [
            ...SYSTEM_CRONS.map(s => ({ ...s, lastRunAt: null, lastRunStatus: null, nextRunAt: null })),
            ...dbJobs,
        ]

        res.json(freshResponse(all))
    } catch (err) {
        logger.error({ err }, 'cmd-center: cron jobs failed')
        res.json(freshResponse([]))
    }
})

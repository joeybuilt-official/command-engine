import { Router, type Router as RouterType } from 'express'
import { db, desc, eq } from '../db/index.js'
import { tasks } from '../db/index.js'
import { freshResponse } from './cache.js'
import { logger } from '../logger.js'
import { ulid } from 'ulid'

export const agentsRouter: RouterType = Router()

agentsRouter.get('/tasks', async (_req, res) => {
    try {
        const rows = await db
            .select({ id: tasks.id, status: tasks.status, context: tasks.context, workspaceId: tasks.workspaceId, source: tasks.source, outcomeSummary: tasks.outcomeSummary, createdAt: tasks.createdAt, claimedAt: tasks.claimedAt, completedAt: tasks.completedAt })
            .from(tasks)
            .orderBy(desc(tasks.createdAt))
            .limit(100)

        res.json(freshResponse(rows.map(t => {
            const ctx = t.context as Record<string, unknown> | null
            return {
                id: t.id, status: t.status, description: (ctx?.description as string) ?? (ctx?.message as string) ?? '', productTarget: null,
                source: t.source, outcomeSummary: t.outcomeSummary ?? null,
                createdAt: t.createdAt, startedAt: t.claimedAt, completedAt: t.completedAt, result: null,
            }
        })))
    } catch (err) {
        logger.error({ err }, 'cmd-center: agent tasks failed')
        res.json(freshResponse([]))
    }
})

agentsRouter.get('/tasks/:id', async (req, res) => {
    try {
        const [row] = await db.select().from(tasks).where(eq(tasks.id, req.params.id)).limit(1)
        if (!row) { res.status(404).json({ error: 'Task not found' }); return }
        const ctx = row.context as Record<string, unknown> | null
        res.json(freshResponse({
            id: row.id, status: row.status, description: (ctx?.description as string) ?? (ctx?.message as string) ?? '', productTarget: null,
            createdAt: row.createdAt, startedAt: row.claimedAt, completedAt: row.completedAt, result: null,
        }))
    } catch (err) {
        logger.error({ err }, 'cmd-center: agent task detail failed')
        res.status(500).json({ error: 'Internal error' })
    }
})

agentsRouter.post('/tasks', async (req, res) => {
    try {
        const { description } = req.body
        if (!description) { res.status(400).json({ error: 'description required' }); return }
        const [task] = await db.insert(tasks).values({
            id: ulid(),
            context: { description } as Record<string, unknown>,
            type: 'general',
            source: 'api',
            status: 'queued',
            workspaceId: process.env.CMD_CENTER_WORKSPACE_ID ?? '',
        }).returning()
        const ctx = task!.context as Record<string, unknown> | null
        res.json(freshResponse({
            id: task!.id, status: task!.status, description: (ctx?.description as string) ?? '',
            productTarget: null, createdAt: task!.createdAt, startedAt: null, completedAt: null, result: null,
        }))
    } catch (err) {
        logger.error({ err }, 'cmd-center: dispatch task failed')
        res.status(500).json({ error: 'Failed to dispatch task' })
    }
})

agentsRouter.get('/sessions', async (_req, res) => {
    // Stubbed — agent-loop is not available in command-engine
    res.json(freshResponse([]))
})

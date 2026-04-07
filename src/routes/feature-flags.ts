import { Router, type Router as RouterType } from 'express'
import { db, featureFlags, eq } from '../db/index.js'
import { logger } from '../logger.js'

export const featureFlagsRouter: RouterType = Router()

featureFlagsRouter.get('/', async (_req, res) => {
    try {
        const rows = await db.select().from(featureFlags).orderBy(featureFlags.key)
        res.json({ data: rows })
    } catch (err) {
        logger.error({ err }, 'feature flags list failed')
        res.status(500).json({ error: { code: 'INTERNAL', message: 'List failed' } })
    }
})

featureFlagsRouter.post('/', async (req, res) => {
    try {
        const { key, name, description, active, rollout_percentage } = req.body as {
            key?: string; name?: string; description?: string
            active?: boolean; rollout_percentage?: number
        }
        if (!key?.trim()) {
            res.status(400).json({ error: { code: 'MISSING_KEY', message: 'key required' } })
            return
        }

        const [row] = await db.insert(featureFlags).values({
            key: key.trim(),
            name: name ?? null,
            description: description ?? null,
            active: active ?? false,
            rolloutPercentage: rollout_percentage ?? 100,
        }).returning()

        res.status(201).json(row)
    } catch (err) {
        logger.error({ err }, 'feature flag create failed')
        res.status(500).json({ error: { code: 'INTERNAL', message: 'Create failed' } })
    }
})

featureFlagsRouter.patch('/:id', async (req, res) => {
    try {
        const { active, name, description, rollout_percentage } = req.body as {
            active?: boolean; name?: string; description?: string; rollout_percentage?: number
        }

        const update: Record<string, unknown> = { updatedAt: new Date() }
        if (active !== undefined) update.active = active
        if (name !== undefined) update.name = name
        if (description !== undefined) update.description = description
        if (rollout_percentage !== undefined) update.rolloutPercentage = rollout_percentage

        const [row] = await db.update(featureFlags)
            .set(update)
            .where(eq(featureFlags.id, req.params.id))
            .returning()

        if (!row) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Flag not found' } })
            return
        }
        res.json(row)
    } catch (err) {
        logger.error({ err }, 'feature flag update failed')
        res.status(500).json({ error: { code: 'INTERNAL', message: 'Update failed' } })
    }
})

featureFlagsRouter.delete('/:id', async (req, res) => {
    try {
        await db.delete(featureFlags).where(eq(featureFlags.id, req.params.id))
        res.json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'feature flag delete failed')
        res.status(500).json({ error: { code: 'INTERNAL', message: 'Delete failed' } })
    }
})

import { Router, type Router as RouterType } from 'express'
import { db, eq } from '../db/index.js'
import { installedConnections, connectionsRegistry } from '../db/index.js'
import { freshResponse } from './cache.js'
import { logger } from '../logger.js'

export const connectionsRouter: RouterType = Router()

connectionsRouter.get('/', async (_req, res) => {
    try {
        const wsId = process.env.CMD_CENTER_WORKSPACE_ID
        if (!wsId) {
            res.json(freshResponse({ registry: [], installed: [] }))
            return
        }

        const registry = await db.select({
            id: connectionsRegistry.id,
            name: connectionsRegistry.name,
            description: connectionsRegistry.description,
            category: connectionsRegistry.category,
            authType: connectionsRegistry.authType,
            isCore: connectionsRegistry.isCore,
            toolsProvided: connectionsRegistry.toolsProvided,
        }).from(connectionsRegistry)

        const installed = await db.select({
            id: installedConnections.id,
            registryId: installedConnections.registryId,
            name: installedConnections.name,
            status: installedConnections.status,
            lastVerifiedAt: installedConnections.lastVerifiedAt,
            errorDetail: installedConnections.errorDetail,
            createdAt: installedConnections.createdAt,
        })
            .from(installedConnections)
            .where(eq(installedConnections.workspaceId, wsId))

        res.json(freshResponse({ registry, installed }))
    } catch (err) {
        logger.error({ err }, 'cmd-center: connections failed')
        res.json(freshResponse({ registry: [], installed: [] }))
    }
})

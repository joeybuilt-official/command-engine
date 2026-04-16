import { Router, type Router as RouterType } from 'express'
import { db, eq } from '../db/index.js'
import { connectionsRegistry } from '../db/index.js'
import { statusRouter } from './status.js'
import { coolifyRouter } from './coolify.js'
import { githubRouter } from './github.js'
import { ovhcloudRouter } from './ovhcloud.js'
import { agentsRouter } from './agents.js'
import { containersRouter } from './containers.js'
import { databaseRouter } from './database.js'
import { envRouter } from './env.js'
import { healthTimelineRouter } from './health.js'
import { healthTimelineRouter as infraHealthRouter } from './health-timeline.js'
import { backupsRouter } from './backups.js'
import { cronJobsRouter } from './cron-jobs.js'
import { connectionsRouter } from './connections.js'
import { aiProvidersRouter } from './ai-providers.js'
import { deploymentsRouter } from './deployments.js'
import { readRouter } from './analytics.js'
import { featureFlagsRouter } from './feature-flags.js'
import { flagsRouter } from './flags.js'
import { chatRouter as chatProxyRouter } from './chat.js'
import { trainingDataRouter } from './training-data.js'
import { channelsRouter } from './channels.js'
import { extensionsRouter as extProxyRouter } from './extensions.js'
import { logger } from '../logger.js'

export const cmdCenterRouter: RouterType = Router()

cmdCenterRouter.use('/deployments', deploymentsRouter)
cmdCenterRouter.use('/analytics', readRouter)
cmdCenterRouter.use('/feature-flags', featureFlagsRouter)
cmdCenterRouter.use('/status', statusRouter)
cmdCenterRouter.use('/coolify', coolifyRouter)
cmdCenterRouter.use('/github', githubRouter)
cmdCenterRouter.use('/ovhcloud', ovhcloudRouter)
cmdCenterRouter.use('/agents', agentsRouter)
cmdCenterRouter.use('/containers', containersRouter)
cmdCenterRouter.use('/database', databaseRouter)
cmdCenterRouter.use('/env', envRouter)
cmdCenterRouter.use('/health', healthTimelineRouter)
cmdCenterRouter.use('/backups', backupsRouter)
cmdCenterRouter.use('/cron', cronJobsRouter)
cmdCenterRouter.use('/connections', connectionsRouter)
cmdCenterRouter.use('/ai-providers', aiProvidersRouter)
cmdCenterRouter.use('/health-timeline', infraHealthRouter)
cmdCenterRouter.use('/flags', flagsRouter)
cmdCenterRouter.use('/chat', chatProxyRouter)
cmdCenterRouter.use('/channels', channelsRouter)
cmdCenterRouter.use('/extensions', extProxyRouter)
cmdCenterRouter.use('/training-data', trainingDataRouter)

// Admin: seed connection registry entries (idempotent)
cmdCenterRouter.post('/seed-registry', async (_req, res) => {
    try {
        const entries = [
            { id: 'coolify', name: 'Coolify', description: 'Self-hosted PaaS — manage deployments, services, and infrastructure.', category: 'infrastructure', authType: 'api_key' as const, isCore: true, setupFields: [{ key: 'token', label: 'API Token', type: 'password', required: true }, { key: 'base_url', label: 'Coolify URL', type: 'url', required: true }], toolsProvided: ['list_services', 'list_deployments', 'redeploy_service'] },
            { id: 'ovhcloud', name: 'OVHcloud', description: 'Cloud infrastructure — monitor dedicated servers.', category: 'infrastructure', authType: 'api_key' as const, isCore: true, setupFields: [{ key: 'application_key', label: 'Application Key', type: 'text', required: true }, { key: 'application_secret', label: 'Application Secret', type: 'password', required: true }, { key: 'consumer_key', label: 'Consumer Key', type: 'password', required: true }], toolsProvided: ['list_servers', 'get_server_status'] },
            { id: 'mcp_custom', name: 'MCP Server', description: 'Connect any Model Context Protocol server — local or remote. Tools are discovered automatically on connect.', category: 'mcp', authType: 'none' as const, isCore: true, setupFields: [{ key: 'transport', label: 'Transport', type: 'select', required: true, options: ['sse', 'stdio'] }, { key: 'url', label: 'Server URL (for SSE)', type: 'url', required: false }, { key: 'command', label: 'Command (for stdio)', type: 'text', required: false }, { key: 'args', label: 'Arguments (for stdio, comma-separated)', type: 'text', required: false }, { key: 'api_key', label: 'API Key (optional)', type: 'password', required: false }], toolsProvided: ['(discovered on connect)'], docUrl: 'https://modelcontextprotocol.io' },
        ]

        const results: string[] = []
        for (const entry of entries) {
            const [existing] = await db.select({ id: connectionsRegistry.id }).from(connectionsRegistry).where(eq(connectionsRegistry.id, entry.id)).limit(1)
            if (existing) {
                results.push(`${entry.id}: already exists`)
                continue
            }
            await db.insert(connectionsRegistry).values({
                id: entry.id,
                name: entry.name,
                description: entry.description,
                category: entry.category,
                authType: entry.authType,
                isCore: entry.isCore,
                setupFields: entry.setupFields,
                toolsProvided: entry.toolsProvided,
                oauthScopes: [],
                cardsProvided: [],
            }).onConflictDoNothing()
            results.push(`${entry.id}: created`)
        }

        res.json({ results })
    } catch (err) {
        logger.error({ err }, 'cmd-center: seed-registry failed')
        res.status(500).json({ error: 'Failed to seed registry' })
    }
})

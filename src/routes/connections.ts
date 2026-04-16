import { Router, type Router as RouterType } from 'express'
import { db, eq, and } from '../db/index.js'
import { installedConnections, connectionsRegistry } from '../db/index.js'
import { freshResponse } from './cache.js'
import { logger } from '../logger.js'
import { encrypt, decrypt } from '../crypto.js'
import { UUID_RE } from '../validation.js'

export const connectionsRouter: RouterType = Router()

function getWorkspaceId(): string | null {
    return process.env.CMD_CENTER_WORKSPACE_ID ?? null
}

// ── GET / — List registry + installed connections ───────────────

connectionsRouter.get('/', async (_req, res) => {
    try {
        const wsId = getWorkspaceId()
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
            isGenerated: connectionsRegistry.isGenerated,
            toolsProvided: connectionsRegistry.toolsProvided,
            setupFields: connectionsRegistry.setupFields,
            oauthScopes: connectionsRegistry.oauthScopes,
            docUrl: connectionsRegistry.docUrl,
            logoUrl: connectionsRegistry.logoUrl,
        }).from(connectionsRegistry)

        const installed = await db.select({
            id: installedConnections.id,
            registryId: installedConnections.registryId,
            name: installedConnections.name,
            status: installedConnections.status,
            enabledTools: installedConnections.enabledTools,
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

// ── POST /install — Install a connection ────────────────────────

connectionsRouter.post('/install', async (req, res) => {
    try {
        const wsId = getWorkspaceId()
        if (!wsId) { res.status(400).json({ error: 'Workspace not configured' }); return }

        const { registryId, credentials, name } = req.body
        if (!registryId || !credentials) {
            res.status(400).json({ error: 'registryId and credentials are required' })
            return
        }

        const [entry] = await db.select({ id: connectionsRegistry.id, name: connectionsRegistry.name })
            .from(connectionsRegistry)
            .where(eq(connectionsRegistry.id, registryId))

        if (!entry) { res.status(404).json({ error: 'Registry entry not found' }); return }

        const encryptedCreds = Object.keys(credentials).length > 0
            ? { encrypted: encrypt(JSON.stringify(credentials), wsId) }
            : {}

        const [row] = await db.insert(installedConnections).values({
            workspaceId: wsId,
            registryId,
            name: name ?? entry.name,
            credentials: encryptedCreds,
        }).returning({ id: installedConnections.id })

        res.json({ id: row!.id, message: 'Connection installed' })
    } catch (err) {
        logger.error({ err }, 'cmd-center: install connection failed')
        res.status(500).json({ error: 'Failed to install connection' })
    }
})

// ── PATCH /:id — Update status and/or credentials ──────────────

connectionsRouter.patch('/:id', async (req, res) => {
    try {
        const wsId = getWorkspaceId()
        if (!wsId) { res.status(400).json({ error: 'Workspace not configured' }); return }

        const { id } = req.params
        if (!UUID_RE.test(id)) { res.status(400).json({ error: 'Invalid connection ID' }); return }

        const { status, credentials } = req.body
        if (!status && !credentials) {
            res.status(400).json({ error: 'Nothing to update' })
            return
        }

        const updates: Record<string, unknown> = {}
        if (status) updates.status = status
        if (credentials) updates.credentials = { encrypted: encrypt(JSON.stringify(credentials), wsId) }

        await db.update(installedConnections)
            .set(updates)
            .where(and(
                eq(installedConnections.id, id),
                eq(installedConnections.workspaceId, wsId),
            ))

        res.json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'cmd-center: update connection failed')
        res.status(500).json({ error: 'Failed to update connection' })
    }
})

// ── PUT /:id/tools — Toggle enabled tools ──────────────────────

connectionsRouter.put('/:id/tools', async (req, res) => {
    try {
        const wsId = getWorkspaceId()
        if (!wsId) { res.status(400).json({ error: 'Workspace not configured' }); return }

        const { id } = req.params
        if (!UUID_RE.test(id)) { res.status(400).json({ error: 'Invalid connection ID' }); return }

        const { enabledTools } = req.body

        await db.update(installedConnections)
            .set({ enabledTools })
            .where(and(
                eq(installedConnections.id, id),
                eq(installedConnections.workspaceId, wsId),
            ))

        res.json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'cmd-center: update tools failed')
        res.status(500).json({ error: 'Failed to update tools' })
    }
})

// ── DELETE /:id — Disconnect/uninstall ──────────────────────────

connectionsRouter.delete('/:id', async (req, res) => {
    try {
        const wsId = getWorkspaceId()
        if (!wsId) { res.status(400).json({ error: 'Workspace not configured' }); return }

        const { id } = req.params
        if (!UUID_RE.test(id)) { res.status(400).json({ error: 'Invalid connection ID' }); return }

        await db.delete(installedConnections)
            .where(and(
                eq(installedConnections.id, id),
                eq(installedConnections.workspaceId, wsId),
            ))

        res.json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'cmd-center: delete connection failed')
        res.status(500).json({ error: 'Failed to delete connection' })
    }
})

// ── POST /test — Test a connection ──────────────────────────────

connectionsRouter.post('/test', async (req, res) => {
    try {
        const wsId = getWorkspaceId()
        if (!wsId) { res.status(400).json({ error: 'Workspace not configured' }); return }

        let { url, authType, authValue } = req.body
        const { connectionId } = req.body

        if (connectionId) {
            if (!UUID_RE.test(connectionId)) {
                res.status(400).json({ error: 'Invalid connection ID' })
                return
            }

            const [conn] = await db.select({
                credentials: installedConnections.credentials,
                registryId: installedConnections.registryId,
            })
                .from(installedConnections)
                .where(and(
                    eq(installedConnections.id, connectionId),
                    eq(installedConnections.workspaceId, wsId),
                ))

            if (!conn) { res.status(404).json({ error: 'Connection not found' }); return }

            const raw = conn.credentials as { encrypted?: string } | null
            if (!raw?.encrypted) { res.status(400).json({ error: 'No credentials stored' }); return }
            const decrypted = JSON.parse(decrypt(raw.encrypted, wsId))

            const [registry] = await db.select({ authType: connectionsRegistry.authType })
                .from(connectionsRegistry)
                .where(eq(connectionsRegistry.id, conn.registryId))

            url = url ?? decrypted.url ?? decrypted.baseUrl
            authType = authType ?? registry?.authType ?? 'api_key'
            authValue = authValue ?? decrypted.apiKey ?? decrypted.token ?? decrypted.authValue
        }

        // Provider-specific test logic for connections without a generic URL
        const registryId = req.body.registryId ?? (connectionId ? undefined : null)
        let resolvedRegistryId = registryId
        if (!resolvedRegistryId && connectionId) {
            const [conn2] = await db.select({ registryId: installedConnections.registryId })
                .from(installedConnections).where(eq(installedConnections.id, connectionId)).limit(1)
            resolvedRegistryId = conn2?.registryId
        }

        if (resolvedRegistryId === 'telegram' || (!url && authValue)) {
            // Telegram: test bot token via getMe
            const token = authValue
            if (!token) { res.status(400).json({ error: 'No bot token to test' }); return }
            const tgResp = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
                signal: AbortSignal.timeout(10_000),
            })
            const tgData = await tgResp.json() as { ok: boolean; result?: { username: string } }
            if (tgData.ok && tgData.result) {
                res.json({ ok: true, status: 200, statusText: `Bot: @${tgData.result.username}`, contentType: 'application/json' })
            } else {
                res.json({ ok: false, status: tgResp.status, statusText: 'Invalid bot token', contentType: 'application/json' })
            }
            return
        }

        if (!url) { res.status(400).json({ error: 'No URL to test' }); return }

        const headers: Record<string, string> = {}
        if (authType === 'api_key' && authValue) {
            headers['Authorization'] = `Bearer ${authValue}`
        } else if (authType === 'oauth2' && authValue) {
            headers['Authorization'] = `Bearer ${authValue}`
        }

        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 10_000)

        const response = await fetch(url, {
            method: 'GET',
            headers,
            signal: controller.signal,
        })
        clearTimeout(timeout)

        res.json({
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            contentType: response.headers.get('content-type'),
        })
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Connection test failed'
        logger.error({ err }, 'cmd-center: test connection failed')
        res.json({ ok: false, status: 0, statusText: message, contentType: null })
    }
})

// ── POST /custom — Create custom MCP/API connection ─────────────

connectionsRouter.post('/custom', async (req, res) => {
    try {
        const wsId = getWorkspaceId()
        if (!wsId) { res.status(400).json({ error: 'Workspace not configured' }); return }

        const { type, name, url, description, authType, authValue, discoveredTools } = req.body

        if (!type || !name || !url) {
            res.status(400).json({ error: 'type, name, and url are required' })
            return
        }
        if (type !== 'mcp' && type !== 'custom_api') {
            res.status(400).json({ error: 'type must be mcp or custom_api' })
            return
        }

        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        const registryId = `custom-${type}-${slug}-${Date.now()}`

        await db.insert(connectionsRegistry).values({
            id: registryId,
            name,
            description: description ?? `Custom ${type === 'mcp' ? 'MCP' : 'API'} connection`,
            category: type === 'mcp' ? 'mcp' : 'api',
            authType: authType ?? 'api_key',
            toolsProvided: discoveredTools ?? [],
            isGenerated: true,
        })

        const credentials: Record<string, unknown> = { url }
        if (authValue) credentials.token = authValue
        if (authType) credentials.authType = authType

        const encryptedCreds = { encrypted: encrypt(JSON.stringify(credentials), wsId) }

        const [row] = await db.insert(installedConnections).values({
            workspaceId: wsId,
            registryId,
            name,
            credentials: encryptedCreds,
        }).returning({ id: installedConnections.id })

        res.json({ id: row!.id, registryId, message: 'Custom connection created' })
    } catch (err) {
        logger.error({ err }, 'cmd-center: create custom connection failed')
        res.status(500).json({ error: 'Failed to create custom connection' })
    }
})

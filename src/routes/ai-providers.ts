import { Router, type Router as RouterType } from 'express'
import { db, eq } from '../db/index.js'
import { workspaces } from '../db/index.js'
import { freshResponse } from './cache.js'
import { logger } from '../logger.js'

export const aiProvidersRouter: RouterType = Router()

aiProvidersRouter.get('/', async (_req, res) => {
    try {
        const wsId = process.env.CMD_CENTER_WORKSPACE_ID
        if (!wsId) {
            res.json(freshResponse({ inferenceMode: 'byok', providers: {} }))
            return
        }

        const [ws] = await db.select({ settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, wsId))
            .limit(1)

        if (!ws) {
            res.json(freshResponse({ inferenceMode: 'byok', providers: {} }))
            return
        }

        const settings = ws.settings as Record<string, unknown> | null
        if (!settings) {
            res.json(freshResponse({ inferenceMode: 'byok', providers: {} }))
            return
        }

        // Support both legacy (aiProviders) and new (vault/arbiter) formats
        const vault = (settings.vault ?? {}) as Record<string, { apiKey?: string; baseUrl?: string }>
        const arbiter = (settings.arbiter ?? {}) as {
            inferenceMode?: string
            primaryProvider?: string
            fallbackChain?: string[]
            providers?: Record<string, { selectedModel?: string; defaultModel?: string; enabled?: boolean }>
        }
        const legacy = settings.aiProviders as {
            inferenceMode?: string
            primary?: string
            primaryProvider?: string
            providers?: Record<string, { apiKey?: string; selectedModel?: string; defaultModel?: string; enabled?: boolean; baseUrl?: string }>
        } | undefined

        // Merge into a unified view (redacted)
        const providerKeys = new Set([
            ...Object.keys(vault),
            ...Object.keys(arbiter.providers ?? {}),
            ...Object.keys(legacy?.providers ?? {}),
        ])

        const providers: Record<string, {
            hasKey: boolean
            enabled: boolean
            model: string | null
            baseUrl: string | null
        }> = {}

        for (const key of providerKeys) {
            const v = vault[key]
            const a = arbiter.providers?.[key]
            const l = legacy?.providers?.[key]

            const hasKey = !!(v?.apiKey || l?.apiKey)
            const enabled = a?.enabled ?? l?.enabled ?? hasKey
            const model = a?.selectedModel ?? a?.defaultModel ?? l?.selectedModel ?? l?.defaultModel ?? null
            const baseUrl = v?.baseUrl ?? l?.baseUrl ?? null

            providers[key] = { hasKey, enabled, model, baseUrl }
        }

        const inferenceMode = arbiter.inferenceMode ?? legacy?.inferenceMode ?? 'byok'
        const primaryProvider = arbiter.primaryProvider ?? legacy?.primaryProvider ?? legacy?.primary ?? null

        res.json(freshResponse({
            inferenceMode,
            primaryProvider,
            fallbackChain: arbiter.fallbackChain ?? [],
            providers,
        }))
    } catch (err) {
        logger.error({ err }, 'cmd-center: ai-providers failed')
        res.json(freshResponse({ inferenceMode: 'byok', providers: {} }))
    }
})

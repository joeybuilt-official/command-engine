import { Router, type Router as RouterType } from 'express'
import { db, eq } from '../db/index.js'
import { workspaces } from '../db/index.js'
import { freshResponse } from './cache.js'
import { logger } from '../logger.js'
import { encrypt } from '../crypto.js'

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

// ── PUT / — Save AI provider configuration ──────────────────────

aiProvidersRouter.put('/', async (req, res) => {
    try {
        const wsId = process.env.CMD_CENTER_WORKSPACE_ID
        if (!wsId) {
            res.status(400).json({ ok: false, message: 'No workspace configured' })
            return
        }

        const { primaryProvider, fallbackChain, providers } = req.body as {
            primaryProvider?: string
            fallbackChain?: string[]
            providers?: Record<string, {
                apiKey?: string
                baseUrl?: string
                selectedModel?: string
                enabled?: boolean
            }>
        }

        // Read current settings
        const [ws] = await db.select({ settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, wsId))
            .limit(1)

        const settings = (ws?.settings ?? {}) as Record<string, unknown>
        const vault = { ...(settings.vault ?? {}) as Record<string, Record<string, string>> }
        const arbiter = { ...(settings.arbiter ?? {}) as Record<string, unknown> }
        const arbiterProviders = { ...(arbiter.providers ?? {}) as Record<string, Record<string, unknown>> }

        // Merge provider-level fields
        if (providers) {
            for (const [name, cfg] of Object.entries(providers)) {
                // Vault: apiKey + baseUrl
                if (cfg.apiKey !== undefined || cfg.baseUrl !== undefined) {
                    const existing = { ...(vault[name] ?? {}) }
                    if (cfg.apiKey !== undefined) {
                        existing.apiKey = cfg.apiKey ? encrypt(cfg.apiKey, wsId) : ''
                    }
                    if (cfg.baseUrl !== undefined) {
                        existing.baseUrl = cfg.baseUrl
                    }
                    vault[name] = existing
                }

                // Arbiter: selectedModel + enabled
                if (cfg.selectedModel !== undefined || cfg.enabled !== undefined) {
                    const existing = { ...(arbiterProviders[name] ?? {}) }
                    if (cfg.selectedModel !== undefined) existing.selectedModel = cfg.selectedModel
                    if (cfg.enabled !== undefined) existing.enabled = cfg.enabled
                    arbiterProviders[name] = existing
                }
            }
        }

        // Arbiter top-level fields
        if (primaryProvider !== undefined) arbiter.primaryProvider = primaryProvider
        if (fallbackChain !== undefined) arbiter.fallbackChain = fallbackChain
        arbiter.providers = arbiterProviders

        const updated = { ...settings, vault, arbiter }

        await db.update(workspaces)
            .set({ settings: updated })
            .where(eq(workspaces.id, wsId))

        res.json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'cmd-center: ai-providers PUT failed')
        res.status(500).json({ ok: false, message: 'Failed to save provider config' })
    }
})

// ── POST /test — Test a provider connection ─────────────────────

aiProvidersRouter.post('/test', async (req, res) => {
    try {
        const { provider, apiKey, baseUrl, model } = req.body as {
            provider: string
            apiKey: string
            baseUrl?: string
            model?: string
        }

        if (!provider || !apiKey) {
            res.status(400).json({ ok: false, message: 'provider and apiKey are required' })
            return
        }

        const normalised = provider.toLowerCase()

        // Ollama — no auth needed, just check tags
        if (normalised === 'ollama') {
            const url = (baseUrl || 'http://localhost:11434').replace(/\/$/, '')
            const resp = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(10_000) })
            if (!resp.ok) {
                res.json({ ok: false, message: `Ollama responded ${resp.status}` })
                return
            }
            const data = await resp.json() as { models?: { name: string }[] }
            const models = (data.models ?? []).map(m => m.name)
            res.json({ ok: true, message: 'Connected to Ollama', models })
            return
        }

        // Anthropic — POST /v1/messages with minimal payload
        if (normalised === 'anthropic') {
            const url = (baseUrl || 'https://api.anthropic.com').replace(/\/$/, '')
            const testModel = model || 'claude-sonnet-4-5-20250514'
            const resp = await fetch(`${url}/v1/messages`, {
                method: 'POST',
                headers: {
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    model: testModel,
                    max_tokens: 1,
                    messages: [{ role: 'user', content: 'hi' }],
                }),
                signal: AbortSignal.timeout(15_000),
            })

            if (!resp.ok) {
                const body = await resp.text()
                // 401/403 = bad key; anything else still proves connectivity
                if (resp.status === 401 || resp.status === 403) {
                    res.json({ ok: false, message: 'Invalid API key' })
                    return
                }
                // Overloaded or rate-limited but key is valid
                if (resp.status === 429 || resp.status === 529) {
                    res.json({ ok: true, message: 'API key valid (rate limited)' })
                    return
                }
                res.json({ ok: false, message: `Anthropic responded ${resp.status}: ${body.slice(0, 200)}` })
                return
            }
            res.json({ ok: true, message: 'API key valid' })
            return
        }

        // OpenAI-compatible (openai, groq, together, mistral, deepseek, etc.)
        const defaultBaseUrls: Record<string, string> = {
            openai: 'https://api.openai.com/v1',
            groq: 'https://api.groq.com/openai/v1',
            together: 'https://api.together.xyz/v1',
            mistral: 'https://api.mistral.ai/v1',
            deepseek: 'https://api.deepseek.com/v1',
        }
        const url = (baseUrl || defaultBaseUrls[normalised] || `https://api.${normalised}.com/v1`).replace(/\/$/, '')

        const resp = await fetch(`${url}/models`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(10_000),
        })

        if (!resp.ok) {
            if (resp.status === 401 || resp.status === 403) {
                res.json({ ok: false, message: 'Invalid API key' })
                return
            }
            res.json({ ok: false, message: `Provider responded ${resp.status}` })
            return
        }

        const data = await resp.json() as { data?: { id: string }[] }
        const models = (data.data ?? []).map(m => m.id)
        res.json({ ok: true, message: 'API key valid', models })
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Connection failed'
        logger.error({ err }, 'cmd-center: ai-providers test failed')
        res.json({ ok: false, message })
    }
})

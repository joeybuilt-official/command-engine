import { Router, type Router as RouterType } from 'express'
import { resolveCredentials, resolveWorkspaceId } from './resolve-credentials.js'
import { cachedFetch, freshResponse } from './cache.js'
import { logger } from '../logger.js'

export const sentryRouter: RouterType = Router()
const SENTRY = 'https://sentry.io/api/0'

sentryRouter.get('/projects', async (req, res) => {
    try {
        let wsId: string | null = null
        try { wsId = await resolveWorkspaceId(req) } catch (e) { logger.warn({ err: e }, 'cmd-center: workspace resolution failed') }
        if (!wsId) { res.json(freshResponse([])); return }
        const creds = await resolveCredentials(wsId, 'sentry')
        if (!creds) { res.json(freshResponse([])); return }
        const token = (creds.auth_token ?? creds.token ?? '') as string
        const org = (creds.organization ?? '') as string

        const result = await cachedFetch('cmd-center:sentry:projects', 60, async () => {
            const r = await fetch(`${SENTRY}/organizations/${org}/projects/`, { headers: { Authorization: `Bearer ${token}` } })
            if (!r.ok) throw new Error(`Sentry: ${r.status}`)
            const projects = await r.json() as any[]
            return await Promise.all(projects.map(async (p: any) => {
                let errorCount24h = 0
                try {
                    const s = await fetch(`${SENTRY}/projects/${org}/${p.slug}/stats/?stat=received&resolution=1d`, { headers: { Authorization: `Bearer ${token}` } })
                    if (s.ok) { const stats = await s.json() as Array<[number, number]>; errorCount24h = stats.length > 0 ? stats[stats.length - 1]![1] : 0 }
                } catch { /* non-fatal */ }
                return { id: p.id, slug: p.slug, name: p.name, platform: p.platform ?? 'unknown', errorCount24h, crashFreeRate: null }
            }))
        })
        res.json(result)
    } catch (err) {
        logger.error({ err }, 'cmd-center: sentry projects failed')
        res.json(freshResponse([]))
    }
})

sentryRouter.get('/issues', async (req, res) => {
    try {
        let wsId: string | null = null
        try { wsId = await resolveWorkspaceId(req) } catch (e) { logger.warn({ err: e }, 'cmd-center: workspace resolution failed') }
        if (!wsId) { res.json(freshResponse([])); return }
        const creds = await resolveCredentials(wsId, 'sentry')
        if (!creds) { res.json(freshResponse([])); return }
        const token = (creds.auth_token ?? creds.token ?? '') as string
        const org = (creds.organization ?? '') as string
        const project = req.query.project as string | undefined

        const result = await cachedFetch(`cmd-center:sentry:issues:${project ?? 'all'}`, 60, async () => {
            const q = project ? `&project=${project}` : ''
            const r = await fetch(`${SENTRY}/organizations/${org}/issues/?query=is:unresolved${q}&limit=50`, { headers: { Authorization: `Bearer ${token}` } })
            if (!r.ok) return []
            const issues = await r.json() as any[]
            return issues.map((i: any) => ({
                id: i.id, projectSlug: i.project?.slug ?? '', title: i.title, culprit: i.culprit ?? '',
                level: i.level ?? 'error', status: i.status ?? 'unresolved',
                firstSeen: i.firstSeen, lastSeen: i.lastSeen,
                count: parseInt(i.count ?? '0', 10), userCount: i.userCount ?? 0,
                assignee: i.assignedTo?.name ?? null,
            }))
        })
        res.json(result)
    } catch (err) {
        logger.error({ err }, 'cmd-center: sentry issues failed')
        res.json(freshResponse([]))
    }
})

sentryRouter.post('/issues/:id/resolve', async (req, res) => {
    try {
        let wsId: string | null = null
        try { wsId = await resolveWorkspaceId(req) } catch (e) { logger.warn({ err: e }, 'cmd-center: workspace resolution failed') }
        if (!wsId) { res.json(freshResponse({ resolved: false })); return }
        const creds = await resolveCredentials(wsId, 'sentry')
        if (!creds) { res.json(freshResponse({ resolved: false })); return }
        const token = (creds.auth_token ?? creds.token ?? '') as string
        const r = await fetch(`${SENTRY}/issues/${req.params.id}/`, {
            method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'resolved' }),
        })
        res.json(freshResponse({ resolved: r.ok }))
    } catch (err) {
        logger.error({ err }, 'cmd-center: sentry resolve failed')
        res.json(freshResponse({ resolved: false }))
    }
})

sentryRouter.post('/issues/:id/assign', async (req, res) => {
    try {
        let wsId: string | null = null
        try { wsId = await resolveWorkspaceId(req) } catch (e) { logger.warn({ err: e }, 'cmd-center: workspace resolution failed') }
        if (!wsId) { res.json(freshResponse({ assigned: false })); return }
        const creds = await resolveCredentials(wsId, 'sentry')
        if (!creds) { res.json(freshResponse({ assigned: false })); return }
        const token = (creds.auth_token ?? creds.token ?? '') as string
        const r = await fetch(`${SENTRY}/issues/${req.params.id}/`, {
            method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ assignedTo: req.body.assignee }),
        })
        res.json(freshResponse({ assigned: r.ok }))
    } catch (err) {
        logger.error({ err }, 'cmd-center: sentry assign failed')
        res.json(freshResponse({ assigned: false }))
    }
})

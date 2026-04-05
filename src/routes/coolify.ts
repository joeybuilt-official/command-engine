import { Router, type Router as RouterType } from 'express'
import { resolveCredentials, resolveWorkspaceId } from './resolve-credentials.js'
import { cachedFetch, freshResponse } from './cache.js'
import { logger } from '../logger.js'

export const coolifyRouter: RouterType = Router()

coolifyRouter.get('/services', async (req, res) => {
    try {
        let wsId: string | null = null
        try { wsId = await resolveWorkspaceId(req) } catch (e) { logger.warn({ err: e }, 'cmd-center: workspace resolution failed') }
        if (!wsId) { res.json(freshResponse([])); return }
        const creds = await resolveCredentials(wsId, 'coolify')
        if (!creds) { res.json(freshResponse([])); return }

        const token = (creds.token ?? creds.api_token ?? creds.access_token ?? '') as string
        const baseUrl = (creds.base_url ?? '') as string
        const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' }

        const result = await cachedFetch('cmd-center:coolify:services', 60, async () => {
            const appsRes = await fetch(`${baseUrl}/api/v1/applications`, { headers })
            if (!appsRes.ok) throw new Error(`Coolify API: ${appsRes.status}`)
            const apps = await appsRes.json() as any[]
            return apps.map((a: any) => ({
                id: a.uuid ?? a.id,
                name: a.name ?? 'Unknown',
                status: mapCoolifyStatus(a.status),
                type: a.build_pack ?? 'application',
                lastDeployedAt: a.updated_at ?? null,
                lastDeployCommit: null,
                repoUrl: a.git_repository ?? null,
                resourceUsage: { cpu: null, memory: null, disk: null },
            }))
        })
        res.json(result)
    } catch (err) {
        logger.error({ err }, 'cmd-center: coolify services failed')
        res.json(freshResponse([]))
    }
})

coolifyRouter.get('/deployments', async (req, res) => {
    try {
        let wsId: string | null = null
        try { wsId = await resolveWorkspaceId(req) } catch (e) { logger.warn({ err: e }, 'cmd-center: workspace resolution failed') }
        if (!wsId) { res.json(freshResponse([])); return }
        const creds = await resolveCredentials(wsId, 'coolify')
        if (!creds) { res.json(freshResponse([])); return }

        const token = (creds.token ?? creds.api_token ?? '') as string
        const baseUrl = (creds.base_url ?? '') as string
        const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' }
        const serviceId = req.query.serviceId as string | undefined

        const result = await cachedFetch(`cmd-center:coolify:deployments:${serviceId ?? 'all'}`, 60, async () => {
            if (serviceId) {
                const depRes = await fetch(`${baseUrl}/api/v1/applications/${serviceId}/deployments`, { headers })
                if (!depRes.ok) return []
                return mapDeployments(await depRes.json() as any[], serviceId)
            }
            const appsRes = await fetch(`${baseUrl}/api/v1/applications`, { headers })
            if (!appsRes.ok) return []
            const apps = await appsRes.json() as any[]
            const allDeps: any[] = []
            for (const app of apps.slice(0, 20)) {
                try {
                    const depRes = await fetch(`${baseUrl}/api/v1/applications/${app.uuid}/deployments?limit=5`, { headers })
                    if (depRes.ok) allDeps.push(...mapDeployments(await depRes.json() as any[], app.uuid, app.name))
                } catch { /* skip */ }
            }
            return allDeps.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()).slice(0, 50)
        })
        res.json(result)
    } catch (err) {
        logger.error({ err }, 'cmd-center: coolify deployments failed')
        res.json(freshResponse([]))
    }
})

coolifyRouter.post('/services/:id/redeploy', async (req, res) => {
    try {
        let wsId: string | null = null
        try { wsId = await resolveWorkspaceId(req) } catch (e) { logger.warn({ err: e }, 'cmd-center: workspace resolution failed') }
        if (!wsId) { res.json(freshResponse({ triggered: false })); return }
        const creds = await resolveCredentials(wsId, 'coolify')
        if (!creds) { res.json(freshResponse({ triggered: false })); return }

        const token = (creds.token ?? creds.api_token ?? '') as string
        const baseUrl = (creds.base_url ?? '') as string
        const redeployRes = await fetch(`${baseUrl}/api/v1/applications/${req.params.id}/restart`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}` },
        })
        res.json(freshResponse({ triggered: redeployRes.ok }))
    } catch (err) {
        logger.error({ err }, 'cmd-center: coolify redeploy failed')
        res.json(freshResponse({ triggered: false }))
    }
})

function mapCoolifyStatus(status: string | undefined): string {
    if (!status) return 'stopped'
    const s = status.toLowerCase()
    if (s.includes('running') || s === 'healthy') return 'running'
    if (s.includes('deploy') || s.includes('building')) return 'deploying'
    if (s.includes('error') || s.includes('failed') || s.includes('unhealthy')) return 'error'
    return 'stopped'
}

function mapDeployments(deps: any[], serviceId: string, serviceName?: string): any[] {
    return deps.map((d: any) => ({
        id: d.id ?? d.uuid ?? `${serviceId}-${d.created_at}`,
        serviceId, serviceName: serviceName ?? serviceId,
        status: d.status === 'finished' ? 'success' : d.status === 'failed' ? 'failed' : d.status === 'queued' ? 'queued' : 'in_progress',
        commit: d.commit ?? null, branch: d.branch ?? null,
        triggeredBy: d.triggered_by ?? 'unknown',
        startedAt: d.created_at ?? null, finishedAt: d.updated_at ?? null, logs: null,
    }))
}

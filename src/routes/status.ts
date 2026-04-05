import { Router, type Router as RouterType } from 'express'
import { resolveCredentials, resolveWorkspaceId } from './resolve-credentials.js'
import { cachedFetch, freshResponse } from './cache.js'
import { logger } from '../logger.js'

export const statusRouter: RouterType = Router()

statusRouter.get('/', async (req, res) => {
    try {
        let wsId: string | null = null
        try { wsId = await resolveWorkspaceId(req) } catch (e) { logger.warn({ err: e }, 'cmd-center: workspace resolution failed') }

        const emptyStatus = {
            coolify: { healthy: 0, total: 0, services: [] },
            github: { openPrs: 0, openIssues: 0, repos: [] },
            sentry: { totalErrors24h: 0, projects: [] },
            posthog: { totalDau: 0, insights: [] },
            ovhcloud: { servers: [] },
            engine: { health: { status: 'unknown' as string, version: '?', integrations: [] as any[] } },
        }

        const result = await cachedFetch('cmd-center:status', 30, async () => {
            const [coolifyR, githubR, sentryR, posthogR, ovhR, engineR] = await Promise.allSettled([
                wsId ? fetchCoolify(wsId) : Promise.resolve(emptyStatus.coolify),
                wsId ? fetchGitHub(wsId) : Promise.resolve(emptyStatus.github),
                wsId ? fetchSentry(wsId) : Promise.resolve(emptyStatus.sentry),
                wsId ? fetchPostHog(wsId) : Promise.resolve(emptyStatus.posthog),
                wsId ? fetchOVH(wsId) : Promise.resolve(emptyStatus.ovhcloud),
                fetchEngineHealth(),
            ])
            return {
                coolify: coolifyR.status === 'fulfilled' ? coolifyR.value : emptyStatus.coolify,
                github: githubR.status === 'fulfilled' ? githubR.value : emptyStatus.github,
                sentry: sentryR.status === 'fulfilled' ? sentryR.value : emptyStatus.sentry,
                posthog: posthogR.status === 'fulfilled' ? posthogR.value : emptyStatus.posthog,
                ovhcloud: ovhR.status === 'fulfilled' ? ovhR.value : emptyStatus.ovhcloud,
                engine: engineR.status === 'fulfilled' ? engineR.value : emptyStatus.engine,
            }
        })
        res.json(result)
    } catch (err) {
        logger.error({ err }, 'cmd-center: status board failed')
        res.json(freshResponse({
            coolify: { healthy: 0, total: 0, services: [] },
            github: { openPrs: 0, openIssues: 0, repos: [] },
            sentry: { totalErrors24h: 0, projects: [] },
            posthog: { totalDau: 0, insights: [] },
            ovhcloud: { servers: [] },
            engine: { health: { status: 'unhealthy', version: '?', integrations: [] } },
        }))
    }
})

async function fetchCoolify(wsId: string) {
    const creds = await resolveCredentials(wsId, 'coolify')
    if (!creds) return { healthy: 0, total: 0, services: [] }
    const token = (creds.token ?? creds.api_token ?? '') as string
    const baseUrl = (creds.base_url ?? '') as string
    const r = await fetch(`${baseUrl}/api/v1/applications`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
    if (!r.ok) return { healthy: 0, total: 0, services: [] }
    const apps = await r.json() as any[]
    const services = apps.map((a: any) => ({ id: a.uuid ?? a.id, name: a.name ?? 'Unknown', status: mapS(a.status) }))
    return { healthy: services.filter((s: any) => s.status === 'running').length, total: services.length, services }
}

async function fetchGitHub(wsId: string) {
    const creds = await resolveCredentials(wsId, 'github')
    if (!creds) return { openPrs: 0, openIssues: 0, repos: [] }
    const token = (creds.access_token ?? creds.token ?? '') as string
    const r = await fetch('https://api.github.com/user/repos?sort=updated&per_page=20&type=owner', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'CommandEngine/1.0' },
    })
    if (!r.ok) return { openPrs: 0, openIssues: 0, repos: [] }
    const repos = await r.json() as any[]
    let openIssues = 0
    const mapped = repos.map((rp: any) => { openIssues += rp.open_issues_count ?? 0; return { id: rp.id, name: rp.name, openPrsCount: 0 } })
    return { openPrs: 0, openIssues, repos: mapped }
}

async function fetchSentry(wsId: string) {
    const creds = await resolveCredentials(wsId, 'sentry')
    if (!creds) return { totalErrors24h: 0, projects: [] }
    const token = (creds.auth_token ?? creds.token ?? '') as string
    const org = (creds.organization ?? '') as string
    const r = await fetch(`https://sentry.io/api/0/organizations/${org}/projects/`, { headers: { Authorization: `Bearer ${token}` } })
    if (!r.ok) return { totalErrors24h: 0, projects: [] }
    const projects = await r.json() as any[]
    const mapped = projects.map((p: any) => ({ id: p.id, slug: p.slug, name: p.name, errorCount24h: 0 }))
    return { totalErrors24h: 0, projects: mapped }
}

async function fetchPostHog(_wsId: string) { return { totalDau: 0, insights: [] } }
async function fetchOVH(_wsId: string) { return { servers: [] } }

async function fetchEngineHealth() {
    const port = process.env.PORT ?? '3001'
    try {
        const r = await fetch(`http://127.0.0.1:${port}/health`)
        if (!r.ok) return { health: { status: 'unhealthy', version: '?', integrations: [] } }
        const d = await r.json() as any
        return { health: { status: d.status === 'ok' ? 'healthy' : 'degraded', version: d.version ?? '?', integrations: [] as any[] } }
    } catch { return { health: { status: 'unhealthy', version: '?', integrations: [] } } }
}

function mapS(s: string | undefined): string {
    if (!s) return 'stopped'
    const l = s.toLowerCase()
    if (l.includes('running') || l === 'healthy') return 'running'
    if (l.includes('error') || l.includes('failed')) return 'error'
    return 'stopped'
}

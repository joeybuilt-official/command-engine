import { Router, type Router as RouterType } from 'express'
import { resolveCredentials, resolveWorkspaceId } from './resolve-credentials.js'
import { cachedFetch, freshResponse } from './cache.js'
import { logger } from '../logger.js'

export const githubRouter: RouterType = Router()

const GH = 'https://api.github.com'
const ORG = process.env.GITHUB_ORG || ''
const GH_BASE = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'CommandEngine/1.0' }

function requireOrg(res: any): boolean {
    if (!ORG) { res.json(freshResponse([])); return false }
    return true
}
function ghH(token: string) { return { ...GH_BASE, Authorization: `Bearer ${token}` } }

githubRouter.get('/repos', async (req, res) => {
    try {
        if (!ORG) { res.json(freshResponse({ repos: [], openPrs: 0, openIssues: 0 })); return }
        let wsId: string | null = null
        try { wsId = await resolveWorkspaceId(req) } catch (e) { logger.warn({ err: e }, 'cmd-center: workspace resolution failed') }
        if (!wsId) { res.json(freshResponse({ repos: [], openPrs: 0, openIssues: 0 })); return }
        const creds = await resolveCredentials(wsId, 'github')
        if (!creds) { res.json(freshResponse({ repos: [], openPrs: 0, openIssues: 0 })); return }
        const token = (creds.access_token ?? creds.token ?? '') as string

        const result = await cachedFetch('cmd-center:github:repos', 60, async () => {
            const r = await fetch(`${GH}/orgs/${ORG}/repos?sort=updated&per_page=100`, { headers: ghH(token) })
            if (!r.ok) throw new Error(`GitHub: ${r.status}`)
            const repos = (await r.json() as any[])
                .filter((r: any) => (r.full_name as string)?.startsWith(`${ORG}/`))
            let openIssues = 0
            const mapped = repos.map((r: any) => {
                openIssues += r.open_issues_count ?? 0
                return {
                    id: r.id, name: r.name, fullName: r.full_name, description: r.description,
                    url: r.html_url, defaultBranch: r.default_branch, language: r.language,
                    updatedAt: r.updated_at, openIssuesCount: r.open_issues_count ?? 0, openPrsCount: 0,
                }
            })
            return { repos: mapped, openPrs: 0, openIssues }
        })
        res.json(result)
    } catch (err) {
        logger.error({ err }, 'cmd-center: github repos failed')
        res.json(freshResponse({ repos: [], openPrs: 0, openIssues: 0 }))
    }
})

githubRouter.get('/pulls', async (req, res) => {
    try {
        if (!requireOrg(res)) return
        let wsId: string | null = null
        try { wsId = await resolveWorkspaceId(req) } catch (e) { logger.warn({ err: e }, 'cmd-center: workspace resolution failed') }
        if (!wsId) { res.json(freshResponse([])); return }
        const creds = await resolveCredentials(wsId, 'github')
        if (!creds) { res.json(freshResponse([])); return }
        const token = (creds.access_token ?? creds.token ?? '') as string
        const repo = req.query.repo as string | undefined

        const result = await cachedFetch(`cmd-center:github:pulls:${repo ?? 'all'}`, 60, async () => {
            if (repo) {
                if (!repo.startsWith(`${ORG}/`)) return []
                const r = await fetch(`${GH}/repos/${repo}/pulls?state=open&per_page=50`, { headers: ghH(token) })
                if (!r.ok) return []
                return mapPRs(await r.json() as any[], repo)
            }
            const r = await fetch(`${GH}/orgs/${ORG}/repos?sort=updated&per_page=20`, { headers: ghH(token) })
            if (!r.ok) return []
            const repos = (await r.json() as any[]).filter((r: any) => (r.full_name as string)?.startsWith(`${ORG}/`))
            const all: any[] = []
            await Promise.allSettled(repos.map(async (rp: any) => {
                const pr = await fetch(`${GH}/repos/${rp.full_name}/pulls?state=open&per_page=10`, { headers: ghH(token) })
                if (pr.ok) all.push(...mapPRs(await pr.json() as any[], rp.name))
            }))
            return all
        })
        res.json(result)
    } catch (err) {
        logger.error({ err }, 'cmd-center: github pulls failed')
        res.json(freshResponse([]))
    }
})

githubRouter.get('/issues', async (req, res) => {
    try {
        if (!requireOrg(res)) return
        let wsId: string | null = null
        try { wsId = await resolveWorkspaceId(req) } catch (e) { logger.warn({ err: e }, 'cmd-center: workspace resolution failed') }
        if (!wsId) { res.json(freshResponse([])); return }
        const creds = await resolveCredentials(wsId, 'github')
        if (!creds) { res.json(freshResponse([])); return }
        const token = (creds.access_token ?? creds.token ?? '') as string
        const repo = req.query.repo as string | undefined

        const result = await cachedFetch(`cmd-center:github:issues:${repo ?? 'all'}`, 60, async () => {
            if (repo && !repo.startsWith(`${ORG}/`)) return []
            const url = repo ? `${GH}/repos/${repo}/issues?state=open&per_page=50` : `${GH}/orgs/${ORG}/issues?state=open&per_page=50&filter=all`
            const r = await fetch(url, { headers: ghH(token) })
            if (!r.ok) return []
            const issues = await r.json() as any[]
            return issues.filter((i: any) => !i.pull_request).map((i: any) => ({
                id: i.id, repoName: i.repository?.name ?? repo ?? '', number: i.number,
                title: i.title, state: i.state, author: i.user?.login ?? '',
                createdAt: i.created_at, updatedAt: i.updated_at, url: i.html_url,
                labels: (i.labels ?? []).map((l: any) => l.name),
            }))
        })
        res.json(result)
    } catch (err) {
        logger.error({ err }, 'cmd-center: github issues failed')
        res.json(freshResponse([]))
    }
})

githubRouter.get('/workflows', async (req, res) => {
    try {
        if (!requireOrg(res)) return
        let wsId: string | null = null
        try { wsId = await resolveWorkspaceId(req) } catch (e) { logger.warn({ err: e }, 'cmd-center: workspace resolution failed') }
        if (!wsId) { res.json(freshResponse([])); return }
        const creds = await resolveCredentials(wsId, 'github')
        if (!creds) { res.json(freshResponse([])); return }
        const token = (creds.access_token ?? creds.token ?? '') as string
        const repo = req.query.repo as string | undefined

        const result = await cachedFetch(`cmd-center:github:workflows:${repo ?? 'all'}`, 60, async () => {
            if (repo) {
                if (!repo.startsWith(`${ORG}/`)) return []
                const r = await fetch(`${GH}/repos/${repo}/actions/runs?per_page=20`, { headers: ghH(token) })
                if (!r.ok) return []
                const d = await r.json() as { workflow_runs: any[] }
                return mapWFs(d.workflow_runs ?? [], repo)
            }
            const r = await fetch(`${GH}/orgs/${ORG}/repos?sort=updated&per_page=10`, { headers: ghH(token) })
            if (!r.ok) return []
            const repos = (await r.json() as any[]).filter((r: any) => (r.full_name as string)?.startsWith(`${ORG}/`))
            const all: any[] = []
            await Promise.allSettled(repos.map(async (rp: any) => {
                const wr = await fetch(`${GH}/repos/${rp.full_name}/actions/runs?per_page=5`, { headers: ghH(token) })
                if (wr.ok) { const d = await wr.json() as { workflow_runs: any[] }; all.push(...mapWFs(d.workflow_runs ?? [], rp.name)) }
            }))
            return all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 20)
        })
        res.json(result)
    } catch (err) {
        logger.error({ err }, 'cmd-center: github workflows failed')
        res.json(freshResponse([]))
    }
})

function mapPRs(prs: any[], repo: string) {
    return prs.map((p: any) => ({
        id: p.id, repoName: repo, number: p.number, title: p.title,
        state: p.merged_at ? 'merged' : p.state, author: p.user?.login ?? '',
        createdAt: p.created_at, updatedAt: p.updated_at, url: p.html_url,
        draft: p.draft ?? false, labels: (p.labels ?? []).map((l: any) => l.name),
    }))
}

function mapWFs(runs: any[], repo: string) {
    return runs.map((r: any) => ({
        id: r.id, repoName: repo, name: r.name, status: r.status,
        conclusion: r.conclusion, branch: r.head_branch,
        commit: r.head_sha?.slice(0, 7), url: r.html_url, createdAt: r.created_at,
    }))
}

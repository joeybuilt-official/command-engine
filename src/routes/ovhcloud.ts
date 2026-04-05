import { Router, type Router as RouterType } from 'express'
import { createHash } from 'node:crypto'
import { resolveCredentials, resolveWorkspaceId } from './resolve-credentials.js'
import { cachedFetch, freshResponse } from './cache.js'
import { logger } from '../logger.js'

export const ovhcloudRouter: RouterType = Router()

const SERVER_FILTER = (process.env.OVH_SERVER_FILTER || '').toLowerCase()

const ENDPOINTS: Record<string, string> = {
    'ovh-eu': 'https://eu.api.ovh.com/1.0',
    'ovh-us': 'https://api.us.ovhcloud.com/1.0',
    'ovh-ca': 'https://ca.api.ovh.com/1.0',
}

async function ovhRequest(creds: Record<string, unknown>, method: string, path: string): Promise<any> {
    const appKey = (creds.application_key ?? '') as string
    const appSecret = (creds.application_secret ?? '') as string
    const consumerKey = (creds.consumer_key ?? '') as string
    const endpoint = (creds.endpoint ?? 'ovh-eu') as string
    const baseUrl = ENDPOINTS[endpoint] ?? ENDPOINTS['ovh-eu']!
    const url = `${baseUrl}${path}`

    const timeRes = await fetch(`${baseUrl}/auth/time`)
    const timestamp = await timeRes.text()
    const sig = '$1$' + createHash('sha1')
        .update(`${appSecret}+${consumerKey}+${method}+${url}++${timestamp}`)
        .digest('hex')

    const res = await fetch(url, {
        method,
        headers: {
            'X-Ovh-Application': appKey, 'X-Ovh-Consumer': consumerKey,
            'X-Ovh-Timestamp': timestamp, 'X-Ovh-Signature': sig,
            'Content-Type': 'application/json',
        },
    })
    if (!res.ok) throw new Error(`OVH: ${res.status} ${res.statusText}`)
    return res.json()
}

async function resolveOVH(req: any): Promise<{ wsId: string; creds: Record<string, unknown> } | null> {
    let wsId: string | null = null
    try { wsId = await resolveWorkspaceId(req) } catch (e) { logger.warn({ err: e }, 'cmd-center: workspace resolution failed') }
    if (!wsId) { return null }
    const creds = await resolveCredentials(wsId, 'ovhcloud')
    if (!creds) { return null }
    return { wsId, creds }
}

function latestValue(data: any): number | null {
    if (!data) return null
    const values = data?.values ?? data
    if (Array.isArray(values) && values.length > 0) {
        const last = values[values.length - 1]
        return typeof last?.value === 'number' ? last.value : (typeof last === 'number' ? last : null)
    }
    if (typeof data === 'number') return data
    return null
}

async function fetchVPSDetails(creds: Record<string, unknown>, name: string) {
    const info = await ovhRequest(creds, 'GET', `/vps/${encodeURIComponent(name)}`)

    let cpu: number | null = null
    let mem: number | null = null
    let disk: number | null = null
    let netIn: number | null = null
    let netOut: number | null = null

    try {
        const monitoring = await ovhRequest(creds, 'GET', `/vps/${encodeURIComponent(name)}/monitoring?period=lastday`)
        cpu = latestValue(monitoring?.cpu) ?? latestValue(monitoring?.['cpu:used'])
        mem = latestValue(monitoring?.ram) ?? latestValue(monitoring?.mem) ?? latestValue(monitoring?.['mem:used'])
        disk = latestValue(monitoring?.disk) ?? latestValue(monitoring?.['disk:used'])
        netIn = latestValue(monitoring?.['net:rx']) ?? latestValue(monitoring?.netRx)
        netOut = latestValue(monitoring?.['net:tx']) ?? latestValue(monitoring?.netTx)
    } catch (err: any) {
        logger.debug({ err: err?.message, vps: name }, 'OVH: /monitoring failed')
    }

    if (cpu === null && mem === null) {
        try {
            const stats = await ovhRequest(creds, 'GET', `/vps/${encodeURIComponent(name)}/statistics?period=lastday`)
            cpu = latestValue(stats?.cpu) ?? latestValue(stats?.['cpu:used'])
            mem = latestValue(stats?.ram) ?? latestValue(stats?.mem)
        } catch { /* optional */ }
    }

    if (disk === null) {
        try {
            const disks = await ovhRequest(creds, 'GET', `/vps/${encodeURIComponent(name)}/disks`) as string[]
            if (disks.length > 0) {
                try {
                    const diskUse = await ovhRequest(creds, 'GET', `/vps/${encodeURIComponent(name)}/disks/${encodeURIComponent(disks[0]!)}/use`)
                    if (diskUse?.used != null && diskUse?.total != null && diskUse.total > 0) {
                        disk = Math.round((diskUse.used / diskUse.total) * 100)
                    }
                } catch { /* optional */ }
            }
        } catch { /* optional */ }
    }

    let ips: string[] = []
    try {
        ips = await ovhRequest(creds, 'GET', `/vps/${encodeURIComponent(name)}/ips`) as string[]
    } catch { /* optional */ }

    return {
        id: name,
        name: info.displayName ?? info.name ?? name,
        type: 'vps' as const,
        status: info.state === 'running' ? 'ok' : info.state === 'stopped' ? 'critical' : 'warning',
        state: info.state ?? 'unknown',
        uptime: null as number | null,
        metrics: {
            cpuPercent: cpu,
            memoryPercent: mem,
            diskPercent: disk,
            networkIn: netIn,
            networkOut: netOut,
        },
        model: info.model?.name ?? info.offerType ?? null,
        zone: info.zone ?? null,
        ip: info.ip ?? (ips.length > 0 ? ips[0] : null),
        ips,
        vCores: info.model?.vcore ?? info.vcore ?? null,
        memoryGB: info.model?.memory != null ? Math.round(info.model.memory / 1024) : null,
        diskGB: info.model?.disk ?? null,
    }
}

ovhcloudRouter.get('/servers', async (req, res) => {
    try {
        const ovh = await resolveOVH(req)
        if (!ovh) { res.json(freshResponse([])); return }

        const result = await cachedFetch('cmd-center:ovhcloud:servers', 120, async () => {
            const allServers: any[] = []

            try {
                const vpsNames = await ovhRequest(ovh.creds, 'GET', '/vps') as string[]
                const vpsResults = await Promise.allSettled(
                    vpsNames.map(name => fetchVPSDetails(ovh.creds, name))
                )
                allServers.push(...vpsResults
                    .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
                    .map(r => r.value))
            } catch (err: any) { logger.warn({ err: err?.message }, 'OVH: /vps failed') }

            try {
                const serverNames = await ovhRequest(ovh.creds, 'GET', '/dedicated/server') as string[]
                const serverResults = await Promise.allSettled(
                    serverNames.map(async (name) => {
                        const info = await ovhRequest(ovh.creds, 'GET', `/dedicated/server/${encodeURIComponent(name)}`)
                        return {
                            id: name, name: info.reverse ?? name, type: 'dedicated',
                            status: info.state === 'ok' ? 'ok' : info.state === 'error' ? 'critical' : 'warning',
                            state: info.state ?? 'unknown',
                            uptime: null,
                            metrics: { cpuPercent: null, memoryPercent: null, diskPercent: null, networkIn: null, networkOut: null },
                            model: info.commercialRange ?? null, zone: info.datacenter ?? null,
                            ip: info.ip ?? null, ips: info.ip ? [info.ip] : [],
                            vCores: null, memoryGB: null, diskGB: null,
                        }
                    }),
                )
                allServers.push(...serverResults
                    .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
                    .map(r => r.value))
            } catch (err: any) { logger.warn({ err: err?.message }, 'OVH: /dedicated/server failed') }

            return SERVER_FILTER
                ? allServers.filter((s: any) =>
                    s.name.toLowerCase().includes(SERVER_FILTER) ||
                    s.id.toLowerCase().includes(SERVER_FILTER)
                )
                : allServers
        })
        res.json(result)
    } catch (err) {
        logger.error({ err }, 'cmd-center: ovhcloud servers failed')
        res.json(freshResponse([]))
    }
})

ovhcloudRouter.post('/servers/:id/reboot', async (req, res) => {
    try {
        const ovh = await resolveOVH(req)
        if (!ovh) { res.status(403).json({ error: 'No credentials' }); return }
        const id = req.params.id
        await ovhRequest(ovh.creds, 'POST', `/vps/${encodeURIComponent(id)}/reboot`)
        logger.info({ vps: id }, 'OVH: VPS reboot triggered')
        res.json(freshResponse({ ok: true, action: 'reboot', server: id }))
    } catch (err: any) {
        logger.error({ err: err?.message, id: req.params.id }, 'OVH: reboot failed')
        res.status(500).json({ error: err?.message ?? 'Reboot failed' })
    }
})

ovhcloudRouter.post('/servers/:id/start', async (req, res) => {
    try {
        const ovh = await resolveOVH(req)
        if (!ovh) { res.status(403).json({ error: 'No credentials' }); return }
        const id = req.params.id
        await ovhRequest(ovh.creds, 'POST', `/vps/${encodeURIComponent(id)}/start`)
        logger.info({ vps: id }, 'OVH: VPS start triggered')
        res.json(freshResponse({ ok: true, action: 'start', server: id }))
    } catch (err: any) {
        logger.error({ err: err?.message, id: req.params.id }, 'OVH: start failed')
        res.status(500).json({ error: err?.message ?? 'Start failed' })
    }
})

ovhcloudRouter.post('/servers/:id/stop', async (req, res) => {
    try {
        const ovh = await resolveOVH(req)
        if (!ovh) { res.status(403).json({ error: 'No credentials' }); return }
        const id = req.params.id
        await ovhRequest(ovh.creds, 'POST', `/vps/${encodeURIComponent(id)}/stop`)
        logger.info({ vps: id }, 'OVH: VPS stop triggered')
        res.json(freshResponse({ ok: true, action: 'stop', server: id }))
    } catch (err: any) {
        logger.error({ err: err?.message, id: req.params.id }, 'OVH: stop failed')
        res.status(500).json({ error: err?.message ?? 'Stop failed' })
    }
})

ovhcloudRouter.post('/servers/:id/console', async (req, res) => {
    try {
        const ovh = await resolveOVH(req)
        if (!ovh) { res.status(403).json({ error: 'No credentials' }); return }
        const id = req.params.id
        const result = await ovhRequest(ovh.creds, 'POST', `/vps/${encodeURIComponent(id)}/getConsoleUrl`)
        logger.info({ vps: id }, 'OVH: console URL generated')
        res.json(freshResponse({ url: result }))
    } catch (err: any) {
        logger.error({ err: err?.message, id: req.params.id }, 'OVH: getConsoleUrl failed')
        res.status(500).json({ error: err?.message ?? 'Console access failed' })
    }
})

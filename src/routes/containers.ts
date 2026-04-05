import { Router, type Router as RouterType } from 'express'
import { execSync } from 'node:child_process'
import { logger } from '../logger.js'

export const containersRouter: RouterType = Router()

const COMPOSE_DIR = process.env.COMPOSE_DIR ?? '/opt/infra'
const COMPOSE_FILES = process.env.COMPOSE_FILES ?? 'docker-compose.yml,docker-compose.prod.yml'
const COMPOSE_CMD = COMPOSE_FILES.split(',').map(f => `-f ${COMPOSE_DIR}/${f.trim()}`).join(' ')

function dockerEnabled(): boolean {
    return process.env.DOCKER_SOCKET_ENABLED === 'true'
}

function exec(cmd: string, timeout = 30_000): string {
    return execSync(cmd, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 }).trim()
}

// GET /containers — list all containers with status
containersRouter.get('/', (_req, res) => {
    if (!dockerEnabled()) { res.json({ error: 'Docker socket not enabled', containers: [] }); return }
    try {
        const raw = exec('docker ps -a --format "{{.Names}}\\t{{.Status}}\\t{{.Image}}\\t{{.Ports}}"')
        const containers = raw.split('\n').filter(Boolean).map(line => {
            const [name, status, image, ports] = line.split('\t')
            return {
                name, status, image,
                ports: ports ?? '',
                healthy: status?.includes('(healthy)') ?? false,
                running: status?.startsWith('Up') ?? false,
            }
        })
        res.json({ containers })
    } catch (err: any) {
        logger.error({ err: err?.message }, 'Failed to list containers')
        res.status(500).json({ error: err?.message ?? 'Failed to list containers' })
    }
})

// GET /containers/:name/logs — get recent logs
containersRouter.get('/:name/logs', (req, res) => {
    if (!dockerEnabled()) { res.status(503).json({ error: 'Docker socket not enabled' }); return }
    const { name } = req.params
    const lines = parseInt(req.query.lines as string) || 50
    try {
        const logs = exec(`docker logs ${name} --tail ${lines} 2>&1`, 15_000)
        res.json({ container: name, lines, logs })
    } catch (err: any) {
        res.status(500).json({ error: err?.message ?? 'Failed to get logs' })
    }
})

// POST /containers/:name/restart — restart a container
containersRouter.post('/:name/restart', (req, res) => {
    if (!dockerEnabled()) { res.status(503).json({ error: 'Docker socket not enabled' }); return }
    const { name } = req.params
    try {
        exec(`docker restart ${name}`, 60_000)
        logger.info({ container: name }, 'Container restarted')
        res.json({ ok: true, container: name, action: 'restarted' })
    } catch (err: any) {
        res.status(500).json({ error: err?.message ?? 'Failed to restart' })
    }
})

// POST /containers/:name/rebuild — rebuild and restart via compose
containersRouter.post('/:name/rebuild', (req, res) => {
    if (!dockerEnabled()) { res.status(503).json({ error: 'Docker socket not enabled' }); return }
    const { name } = req.params
    const prefix = process.env.COMPOSE_PROJECT_NAME ?? ''
    const service = prefix ? name.replace(new RegExp(`^${prefix}-`), '').replace(/-\d+$/, '') : name.replace(/-\d+$/, '')
    try {
        const output = exec(`docker compose ${COMPOSE_CMD} up -d --build --no-deps --force-recreate ${service} 2>&1`, 300_000)
        logger.info({ container: name, service }, 'Service rebuilt')
        res.json({ ok: true, container: name, service, action: 'rebuilt', output })
    } catch (err: any) {
        res.status(500).json({ error: err?.message ?? 'Failed to rebuild' })
    }
})

// POST /containers/:name/stop — stop a container
containersRouter.post('/:name/stop', (req, res) => {
    if (!dockerEnabled()) { res.status(503).json({ error: 'Docker socket not enabled' }); return }
    const { name } = req.params
    try {
        exec(`docker stop ${name}`, 30_000)
        logger.info({ container: name }, 'Container stopped')
        res.json({ ok: true, container: name, action: 'stopped' })
    } catch (err: any) {
        res.status(500).json({ error: err?.message ?? 'Failed to stop' })
    }
})

// POST /containers/:name/start — start a stopped container
containersRouter.post('/:name/start', (req, res) => {
    if (!dockerEnabled()) { res.status(503).json({ error: 'Docker socket not enabled' }); return }
    const { name } = req.params
    try {
        exec(`docker start ${name}`, 30_000)
        logger.info({ container: name }, 'Container started')
        res.json({ ok: true, container: name, action: 'started' })
    } catch (err: any) {
        res.status(500).json({ error: err?.message ?? 'Failed to start' })
    }
})

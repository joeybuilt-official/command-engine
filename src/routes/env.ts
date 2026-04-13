import { Router, type Router as RouterType } from 'express'
import { execSync } from 'node:child_process'
import { readdirSync, unlinkSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import { logger } from '../logger.js'

export const envRouter: RouterType = Router()

const ENV_PATH = process.env.ENV_FILE_PATH ?? '/opt/infra/.env'

function dockerEnabled(): boolean {
    return process.env.DOCKER_SOCKET_ENABLED === 'true'
}

function exec(cmd: string, timeout = 15_000): string {
    return execSync(cmd, { encoding: 'utf8', timeout, maxBuffer: 512 * 1024 }).trim()
}

const SECRET_PATTERNS = [
    /key/i, /secret/i, /token/i, /password/i, /passwd/i,
    /credential/i, /auth/i, /dsn/i, /private/i, /apikey/i,
]

function isSecret(key: string): boolean {
    return SECRET_PATTERNS.some(p => p.test(key))
}

interface EnvVar {
    key: string
    value: string
    masked: boolean
    line: number
}

function parseEnvFile(content: string): EnvVar[] {
    const vars: EnvVar[] = []
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!.trim()
        if (!line || line.startsWith('#')) continue
        const eqIdx = line.indexOf('=')
        if (eqIdx === -1) continue
        const key = line.substring(0, eqIdx).trim()
        let value = line.substring(eqIdx + 1).trim()
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1)
        }
        if (key) vars.push({ key, value, masked: isSecret(key), line: i + 1 })
    }
    return vars
}

function serializeEnvFile(vars: { key: string; value: string }[], originalContent: string): string {
    const lines = originalContent.split('\n')
    const varMap = new Map(vars.map(v => [v.key, v.value]))
    const written = new Set<string>()

    const result: string[] = []
    for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) {
            result.push(line)
            continue
        }
        const eqIdx = trimmed.indexOf('=')
        if (eqIdx === -1) {
            result.push(line)
            continue
        }
        const key = trimmed.substring(0, eqIdx).trim()
        if (varMap.has(key)) {
            const val = varMap.get(key)!
            const needsQuote = val.includes(' ') || val.includes('#') || val.includes('"')
            result.push(needsQuote ? `${key}="${val}"` : `${key}=${val}`)
            written.add(key)
        }
    }

    for (const v of vars) {
        if (!written.has(v.key)) {
            const needsQuote = v.value.includes(' ') || v.value.includes('#') || v.value.includes('"')
            result.push(needsQuote ? `${v.key}="${v.value}"` : `${v.key}=${v.value}`)
        }
    }

    const out = result.join('\n')
    return out.endsWith('\n') ? out : out + '\n'
}

// GET /env — read all env vars (secrets masked)
envRouter.get('/', (_req, res) => {
    if (!dockerEnabled()) { res.status(503).json({ error: 'Docker socket not enabled' }); return }
    try {
        const content = exec(`cat "${ENV_PATH}"`)
        const vars = parseEnvFile(content)
        const masked = vars.map(v => ({
            ...v,
            value: v.masked ? '••••••••' : v.value,
        }))
        res.json({ vars: masked, path: ENV_PATH })
    } catch (err: any) {
        logger.error({ err: err?.message }, 'Failed to read env file')
        res.status(500).json({ error: err?.message ?? 'Failed to read env file' })
    }
})

// GET /env/reveal?key=SOME_KEY — reveal a single secret value
envRouter.get('/reveal', (req, res) => {
    if (!dockerEnabled()) { res.status(503).json({ error: 'Docker socket not enabled' }); return }
    const key = req.query.key as string
    if (!key) { res.status(400).json({ error: 'key parameter required' }); return }
    try {
        const content = exec(`cat "${ENV_PATH}"`)
        const vars = parseEnvFile(content)
        const found = vars.find(v => v.key === key)
        if (!found) { res.status(404).json({ error: `Key "${key}" not found` }); return }
        logger.info({ key }, 'Secret value revealed')
        res.json({ key: found.key, value: found.value })
    } catch (err: any) {
        res.status(500).json({ error: err?.message ?? 'Failed' })
    }
})

// PUT /env — write updated env vars
envRouter.put('/', (req, res) => {
    if (!dockerEnabled()) { res.status(503).json({ error: 'Docker socket not enabled' }); return }
    const { vars } = req.body as { vars?: { key: string; value: string }[] }
    if (!vars || !Array.isArray(vars)) {
        res.status(400).json({ error: 'vars array required' })
        return
    }

    for (const v of vars) {
        if (!v.key || typeof v.key !== 'string') {
            res.status(400).json({ error: 'Each var must have a key' })
            return
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.key)) {
            res.status(400).json({ error: `Invalid key format: "${v.key}"` })
            return
        }
    }

    try {
        let currentContent = ''
        try {
            currentContent = exec(`cat "${ENV_PATH}"`)
        } catch {
            // File might not exist yet
        }

        // Backup current file before overwriting
        if (currentContent) {
            const ts = new Date().toISOString().replace(/[:.]/g, '-')
            const dir = dirname(ENV_PATH)
            const base = basename(ENV_PATH)
            const backupPath = join(dir, `${base}.backup.${ts}`)
            try {
                exec(`cp "${ENV_PATH}" "${backupPath}"`, 10_000)
                logger.info({ backupPath }, 'Env file backed up')

                // Keep only last 5 backups
                const prefix = `${base}.backup.`
                const backups = readdirSync(dir)
                    .filter(f => f.startsWith(prefix))
                    .sort()
                const toDelete = backups.slice(0, Math.max(0, backups.length - 5))
                for (const old of toDelete) {
                    try { unlinkSync(join(dir, old)) } catch { /* ok */ }
                }
            } catch (backupErr: any) {
                logger.warn({ err: backupErr?.message }, 'Failed to create env backup — proceeding anyway')
            }
        }

        // Log which keys changed (not values)
        const oldVars = parseEnvFile(currentContent)
        const oldMap = new Map(oldVars.map(v => [v.key, v.value]))
        const newMap = new Map(vars.map(v => [v.key, v.value]))
        const added = vars.filter(v => !oldMap.has(v.key)).map(v => v.key)
        const removed = oldVars.filter(v => !newMap.has(v.key)).map(v => v.key)
        const changed = vars.filter(v => oldMap.has(v.key) && oldMap.get(v.key) !== v.value).map(v => v.key)
        if (added.length || removed.length || changed.length) {
            logger.info({ added, removed, changed }, 'Env file key changes')
        }

        const newContent = serializeEnvFile(vars, currentContent)
        const escaped = newContent.replace(/\\/g, '\\\\').replace(/'/g, "'\\''")
        exec(`printf '%s' '${escaped}' > "${ENV_PATH}"`, 30_000)

        logger.info({ varCount: vars.length }, 'Env file updated')
        res.json({ ok: true, varCount: vars.length })
    } catch (err: any) {
        logger.error({ err: err?.message }, 'Failed to write env file')
        res.status(500).json({ error: err?.message ?? 'Failed to write env file' })
    }
})

// GET /env/services — list services that use the .env file (for restart prompt)
envRouter.get('/services', (_req, res) => {
    if (!dockerEnabled()) { res.status(503).json({ error: 'Docker socket not enabled' }); return }
    try {
        const composeDir = process.env.COMPOSE_DIR ?? '/opt/infra'
        const composeFiles = process.env.COMPOSE_FILES ?? 'docker-compose.yml,docker-compose.prod.yml'
        const composeCmd = composeFiles.split(',').map(f => `-f ${composeDir}/${f.trim()}`).join(' ')
        const raw = exec(`docker compose ${composeCmd} ps --format "{{.Name}}\\t{{.Status}}" 2>/dev/null`)
        const services = raw.split('\n').filter(Boolean).map(line => {
            const [name, status] = line.split('\t')
            return { name, status, running: status?.startsWith('Up') ?? false }
        })
        res.json({ services })
    } catch (err: any) {
        res.status(500).json({ error: err?.message ?? 'Failed to list services' })
    }
})

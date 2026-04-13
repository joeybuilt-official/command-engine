import { Router, type Router as RouterType } from 'express'
import { execSync } from 'node:child_process'
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'

export const backupsRouter: RouterType = Router()

const BACKUP_FILENAME_RE = /^[a-zA-Z0-9_.-]+\.(sql|sql\.gz)$/

const BACKUP_DIR = process.env.BACKUP_DIR ?? '/opt/backups'
const PG_CONTAINER = process.env.POSTGRES_CONTAINER ?? 'postgres'
const DATABASES = (process.env.BACKUP_DATABASES ?? 'pushd,plexo,command_engine').split(',').map(s => s.trim()).filter(Boolean)

function dockerEnabled(): boolean {
    return process.env.DOCKER_SOCKET_ENABLED === 'true'
}

function exec(cmd: string, timeout = 300_000): string {
    return execSync(cmd, { encoding: 'utf8', timeout, maxBuffer: 10 * 1024 * 1024 }).trim()
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`
}

// GET /backups — list all backups
backupsRouter.get('/', (_req, res) => {
    if (!dockerEnabled()) { res.status(503).json({ error: 'Docker socket not enabled' }); return }
    try {
        const files = readdirSync(BACKUP_DIR)
            .filter(f => f.endsWith('.sql') || f.endsWith('.sql.gz'))
            .map(name => {
                const path = join(BACKUP_DIR, name)
                const stat = statSync(path)
                const parts = name.match(/^(.+?)_(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.sql(\.gz)?$/)
                return {
                    name,
                    database: parts?.[1] ?? name,
                    timestamp: parts?.[2]?.replace(/-/g, (m, i) => i > 9 ? ':' : m) ?? stat.mtime.toISOString(),
                    size: stat.size,
                    sizeHuman: formatSize(stat.size),
                    compressed: name.endsWith('.gz'),
                    createdAt: stat.mtime.toISOString(),
                }
            })
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

        res.json({ backups: files, backupDir: BACKUP_DIR })
    } catch (err: any) {
        logger.error({ err: err?.message }, 'Failed to list backups')
        res.status(500).json({ error: err?.message ?? 'Failed to list backups' })
    }
})

// POST /backups/create — trigger a new backup
backupsRouter.post('/create', (req, res) => {
    if (!dockerEnabled()) { res.status(503).json({ error: 'Docker socket not enabled' }); return }
    const { database } = req.body as { database?: string }

    const targets = database ? [database] : DATABASES
    for (const db of targets) {
        if (!DATABASES.includes(db)) {
            res.status(400).json({ error: `Unknown database: ${db}` })
            return
        }
    }

    try {
        const results: { database: string; file: string; size: string }[] = []
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

        for (const db of targets) {
            const filename = `${db}_${ts}.sql.gz`
            const hostPath = join(BACKUP_DIR, filename)

            exec(
                `docker exec ${PG_CONTAINER} pg_dump -U postgres -d ${db} --format=plain | gzip > "${hostPath}"`,
                300_000,
            )

            const stat = statSync(hostPath)
            results.push({ database: db, file: filename, size: formatSize(stat.size) })
            logger.info({ database: db, file: filename, size: stat.size }, 'Backup created')
        }

        res.json({ ok: true, backups: results })
    } catch (err: any) {
        logger.error({ err: err?.message }, 'Backup creation failed')
        res.status(500).json({ error: err?.message ?? 'Backup failed' })
    }
})

// POST /backups/restore — restore from a backup file
backupsRouter.post('/restore', (req, res) => {
    if (!dockerEnabled()) { res.status(503).json({ error: 'Docker socket not enabled' }); return }
    const { filename, confirm } = req.body as { filename?: string; confirm?: boolean }

    if (!filename) { res.status(400).json({ error: 'filename required' }); return }
    if (!confirm) { res.status(400).json({ error: 'confirm: true required for restore' }); return }

    if (!BACKUP_FILENAME_RE.test(filename)) {
        res.status(400).json({ error: 'Invalid filename' })
        return
    }

    const parts = filename.match(/^(.+?)_\d{4}/)
    const database = parts?.[1]
    if (!database || !DATABASES.includes(database)) {
        res.status(400).json({ error: `Cannot determine database from filename: ${filename}` })
        return
    }

    const filePath = join(BACKUP_DIR, filename)
    try {
        statSync(filePath)
    } catch {
        res.status(404).json({ error: `Backup file not found: ${filename}` })
        return
    }

    try {
        const isGz = filename.endsWith('.gz')
        const cmd = isGz
            ? `gunzip -c "${filePath}" | docker exec -i ${PG_CONTAINER} psql -U postgres -d ${database} 2>&1`
            : `docker exec -i ${PG_CONTAINER} psql -U postgres -d ${database} < "${filePath}" 2>&1`

        const output = exec(cmd, 600_000)
        logger.warn({ database, filename }, 'Database restored from backup')
        res.json({ ok: true, database, filename, output: output.slice(0, 500) })
    } catch (err: any) {
        logger.error({ err: err?.message, filename }, 'Restore failed')
        res.status(500).json({ error: err?.message ?? 'Restore failed' })
    }
})

// DELETE /backups/:filename — delete a backup file
backupsRouter.delete('/:filename', (req, res) => {
    if (!dockerEnabled()) { res.status(503).json({ error: 'Docker socket not enabled' }); return }
    const { filename } = req.params

    if (!BACKUP_FILENAME_RE.test(filename)) {
        res.status(400).json({ error: 'Invalid filename' })
        return
    }

    const filePath = join(BACKUP_DIR, filename)
    try {
        statSync(filePath)
        unlinkSync(filePath)
        logger.info({ filename }, 'Backup deleted')
        res.json({ ok: true, deleted: filename })
    } catch {
        res.status(404).json({ error: `Backup not found: ${filename}` })
    }
})

// GET /backups/databases — list available databases
backupsRouter.get('/databases', (_req, res) => {
    res.json({ databases: DATABASES })
})

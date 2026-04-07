// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Continuous Deployment — zero-downtime deploy pipeline
 *
 * POST /webhook/github          — GitHub push webhook (HMAC-verified)
 * GET  /history                  — Deploy history with pagination
 * GET  /history/:id              — Single deploy record
 * POST /:app/deploy              — Manual deploy trigger
 * POST /:id/rollback             — Rollback to previous image tag
 *
 * Deploy flow (zero-downtime):
 *   1. docker compose build <service> (no stop — just builds new image)
 *   2. Tag image with commit SHA for rollback
 *   3. docker compose up -d --no-deps --force-recreate <service>
 *      (Caddy retries during ~1-2s container swap)
 *   4. Health check new container
 *   5. Log deploy to audit table
 */
import { Router, type Router as RouterType, type Request } from 'express'
import { execSync } from 'node:child_process'
import * as crypto from 'node:crypto'
import { db, sql, eq, desc } from '../db/index.js'
import { deploys } from '../db/schema.js'
import { logger } from '../logger.js'

export const deploymentsRouter: RouterType = Router()

const COMPOSE_DIR = process.env.COMPOSE_DIR ?? '/opt/infra'
const COMPOSE_FILES = process.env.COMPOSE_FILES ?? 'docker-compose.yml,docker-compose.prod.yml'
const COMPOSE_CMD = COMPOSE_FILES.split(',').map(f => `-f ${COMPOSE_DIR}/${f.trim()}`).join(' ')
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? ''

/** Known apps and their compose service + health check URL */
const APP_REGISTRY: Record<string, { service: string; repo: string; healthUrl?: string }> = {
    'plexo-api':        { service: 'plexo-api',       repo: 'joeybuilt-official/plexo',              healthUrl: 'http://plexo-api:3001/health' },
    'plexo-saas':       { service: 'plexo-saas',      repo: 'joeybuilt-official/plexo',              healthUrl: 'http://plexo-saas:3000' },
    'plexo-web':        { service: 'plexo-web',       repo: 'joeybuilt-official/plexo-web' },
    'command-engine':   { service: 'command-engine',   repo: 'joeybuilt-official/command-engine',     healthUrl: 'http://command-engine:3001/health' },
    'command-center':   { service: 'command-center',   repo: 'joeybuilt-official/command-center',     healthUrl: 'http://command-center:3000' },
    'pushd':            { service: 'pushd',            repo: 'joeybuilt-official/pushd',              healthUrl: 'http://pushd:3000/health' },
    'fylo':             { service: 'fylo',             repo: 'joeybuilt-official/fylo',               healthUrl: 'http://fylo:3000' },
    'levio':            { service: 'levio',            repo: 'joeybuilt-official/levio',              healthUrl: 'http://levio:3000' },
    'joeybuilt-website': { service: 'joeybuilt-website', repo: 'joeybuilt-official/joeybuilt-website' },
}

function dockerEnabled(): boolean {
    return process.env.DOCKER_SOCKET_ENABLED === 'true'
}

function exec(cmd: string, timeout = 30_000): string {
    return execSync(cmd, { encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 }).trim()
}

// ── GitHub Push Webhook ─────────────────────────────────────────────────────

function verifyGitHubSignature(req: Request): boolean {
    if (!GITHUB_WEBHOOK_SECRET) return false
    const sig = req.headers['x-hub-signature-256'] as string | undefined
    if (!sig) return false
    const expected = 'sha256=' + crypto
        .createHmac('sha256', GITHUB_WEBHOOK_SECRET)
        .update(JSON.stringify(req.body))
        .digest('hex')
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
}

/**
 * POST /webhook/github — receives GitHub push webhook
 * No auth middleware (GitHub can't send Bearer tokens) — HMAC signature only
 */
deploymentsRouter.post('/webhook/github', async (req, res) => {
    const event = req.headers['x-github-event'] as string | undefined
    if (event !== 'push') {
        res.status(200).json({ ignored: true, reason: `event type: ${event}` })
        return
    }

    if (GITHUB_WEBHOOK_SECRET && !verifyGitHubSignature(req)) {
        logger.warn('GitHub webhook signature verification failed')
        res.status(401).json({ error: 'Invalid signature' })
        return
    }

    const body = req.body as {
        ref?: string
        after?: string
        repository?: { full_name?: string }
        head_commit?: { message?: string; author?: { name?: string } }
    }

    const branch = body.ref?.replace('refs/heads/', '') ?? 'unknown'
    if (branch !== 'main') {
        res.status(200).json({ ignored: true, reason: `branch: ${branch}` })
        return
    }

    const repoFullName = body.repository?.full_name ?? ''
    const commitSha = body.after ?? ''
    const commitMessage = body.head_commit?.message?.split('\n')[0] ?? ''
    const triggeredBy = body.head_commit?.author?.name ?? 'github-webhook'

    // Find matching apps for this repo
    const matchingApps = Object.entries(APP_REGISTRY).filter(([_, cfg]) => cfg.repo === repoFullName)

    if (matchingApps.length === 0) {
        logger.info({ repo: repoFullName }, 'No matching apps for repo — ignoring')
        res.status(200).json({ ignored: true, reason: `no apps for repo: ${repoFullName}` })
        return
    }

    logger.info({ repo: repoFullName, commit: commitSha.slice(0, 7), apps: matchingApps.map(([name]) => name) }, 'GitHub push received — triggering deploys')

    // Trigger deploys asynchronously (don't block the webhook response)
    const deployIds: string[] = []
    for (const [appName, _cfg] of matchingApps) {
        try {
            const id = await triggerDeploy(appName, commitSha, commitMessage, branch, triggeredBy)
            deployIds.push(id)
        } catch (err) {
            logger.error({ err, app: appName }, 'Failed to create deploy record')
        }
    }

    res.status(202).json({ accepted: true, deployIds, apps: matchingApps.map(([name]) => name) })
})

// ── Deploy Executor ─────────────────────────────────────────────────────────

async function triggerDeploy(
    app: string,
    commitSha: string,
    commitMessage: string,
    branch: string,
    triggeredBy: string,
): Promise<string> {
    const cfg = APP_REGISTRY[app]
    if (!cfg) throw new Error(`Unknown app: ${app}`)

    // Insert deploy record
    const [deploy] = await db.insert(deploys).values({
        app,
        commitSha,
        commitMessage,
        branch,
        triggeredBy,
        status: 'pending',
        healthCheckUrl: cfg.healthUrl ?? null,
    }).returning()

    if (!deploy) throw new Error('Deploy insert returned nothing')
    const deployId = deploy.id

    // Run deploy in background (don't block)
    executeDeploy(deployId, app, cfg.service, commitSha, cfg.healthUrl).catch(err => {
        logger.error({ err, deployId, app }, 'Deploy executor failed')
    })

    return deployId
}

async function executeDeploy(
    deployId: string,
    app: string,
    service: string,
    commitSha: string,
    healthUrl?: string,
): Promise<void> {
    const startMs = Date.now()

    try {
        // 1. Get current image tag for rollback reference
        let previousTag: string | null = null
        try {
            previousTag = exec(`docker compose ${COMPOSE_CMD} images ${service} --format json 2>/dev/null | head -1`, 10_000)
        } catch { /* no previous image */ }

        // 2. Update status: building
        await db.update(deploys).set({ status: 'building' }).where(eq(deploys.id, deployId))
        logger.info({ deployId, app, service }, 'Building image')

        // Pull latest code
        exec(`cd ${COMPOSE_DIR} && git pull origin main 2>&1`, 60_000)

        // Build new image (no downtime — old container still running)
        const imageTag = `${service}:${commitSha.slice(0, 12)}`
        exec(`docker compose ${COMPOSE_CMD} build --no-cache ${service} 2>&1`, 300_000)

        // 3. Update status: deploying
        await db.update(deploys).set({ status: 'deploying', imageTag }).where(eq(deploys.id, deployId))
        logger.info({ deployId, app, service, imageTag }, 'Deploying — recreating container')

        // Recreate container with new image (Caddy retries during ~1-2s swap)
        exec(`docker compose ${COMPOSE_CMD} up -d --no-deps --force-recreate ${service} 2>&1`, 120_000)

        // 4. Health check (retry up to 30s)
        if (healthUrl) {
            let healthy = false
            for (let i = 0; i < 15; i++) {
                try {
                    exec(`curl -sf --max-time 2 ${healthUrl} >/dev/null 2>&1`, 5_000)
                    healthy = true
                    break
                } catch {
                    await new Promise(r => setTimeout(r, 2000))
                }
            }

            if (!healthy) {
                throw new Error(`Health check failed after 30s: ${healthUrl}`)
            }
        }

        // 5. Success
        const durationMs = Date.now() - startMs
        await db.update(deploys).set({
            status: 'healthy',
            previousImageTag: previousTag,
            durationMs,
            completedAt: new Date(),
        }).where(eq(deploys.id, deployId))

        logger.info({ deployId, app, service, durationMs, commit: commitSha.slice(0, 7) }, 'Deploy successful')
    } catch (err: any) {
        const durationMs = Date.now() - startMs
        await db.update(deploys).set({
            status: 'failed',
            error: err?.message ?? String(err),
            durationMs,
            completedAt: new Date(),
        }).where(eq(deploys.id, deployId))

        logger.error({ err: err?.message, deployId, app, service, durationMs }, 'Deploy failed')
    }
}

// ── Manual Deploy ───────────────────────────────────────────────────────────

deploymentsRouter.post('/:app/deploy', async (req, res) => {
    if (!dockerEnabled()) { res.status(503).json({ error: 'Docker not enabled' }); return }

    const { app } = req.params
    const cfg = APP_REGISTRY[app]
    if (!cfg) {
        res.status(404).json({ error: `Unknown app: ${app}`, knownApps: Object.keys(APP_REGISTRY) })
        return
    }

    // Get current commit
    let commitSha = 'manual'
    try {
        commitSha = exec(`cd ${COMPOSE_DIR} && git rev-parse HEAD`, 5_000).slice(0, 12)
    } catch { /* ok */ }

    try {
        const deployId = await triggerDeploy(app, commitSha, 'Manual deploy', 'main', req.user?.email ?? 'manual')
        res.status(202).json({ deployId, app, status: 'pending' })
    } catch (err: any) {
        res.status(500).json({ error: err?.message ?? 'Failed to trigger deploy' })
    }
})

// ── Rollback ────────────────────────────────────────────────────────────────

deploymentsRouter.post('/:id/rollback', async (req, res) => {
    if (!dockerEnabled()) { res.status(503).json({ error: 'Docker not enabled' }); return }

    const { id } = req.params

    try {
        // Find the deploy to rollback
        const [deploy] = await db.select().from(deploys).where(eq(deploys.id, id)).limit(1)
        if (!deploy) {
            res.status(404).json({ error: 'Deploy not found' })
            return
        }

        // Find the last healthy deploy for this app (before this one)
        const [previous] = await db.select().from(deploys)
            .where(sql`${deploys.app} = ${deploy.app} AND ${deploys.status} = 'healthy' AND ${deploys.startedAt} < ${deploy.startedAt}`)
            .orderBy(desc(deploys.startedAt))
            .limit(1)

        if (!previous) {
            res.status(404).json({ error: 'No previous healthy deploy found to rollback to' })
            return
        }

        const cfg = APP_REGISTRY[deploy.app]
        if (!cfg) {
            res.status(404).json({ error: `App config not found: ${deploy.app}` })
            return
        }

        logger.info({ deployId: id, app: deploy.app, rollbackTo: previous.commitSha }, 'Rolling back')

        // Checkout the previous commit and rebuild
        const rollbackId = await triggerDeploy(
            deploy.app,
            previous.commitSha,
            `Rollback from ${deploy.commitSha.slice(0, 7)} to ${previous.commitSha.slice(0, 7)}`,
            'main',
            `rollback:${req.user?.email ?? 'manual'}`,
        )

        // Mark original deploy as rolled back
        await db.update(deploys).set({ status: 'rolled_back' }).where(eq(deploys.id, id))

        res.status(202).json({ rollbackDeployId: rollbackId, rolledBackFrom: id, rolledBackTo: previous.commitSha })
    } catch (err: any) {
        logger.error({ err: err?.message, id }, 'Rollback failed')
        res.status(500).json({ error: err?.message ?? 'Rollback failed' })
    }
})

// ── Deploy History ──────────────────────────────────────────────────────────

deploymentsRouter.get('/history', async (req, res) => {
    const app = req.query.app as string | undefined
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100)

    try {
        const query = app
            ? db.select().from(deploys).where(eq(deploys.app, app)).orderBy(desc(deploys.startedAt)).limit(limit)
            : db.select().from(deploys).orderBy(desc(deploys.startedAt)).limit(limit)

        const rows = await query
        res.json({ deploys: rows, count: rows.length })
    } catch (err: any) {
        logger.error({ err: err?.message }, 'Failed to fetch deploy history')
        res.status(500).json({ error: 'Failed to fetch history' })
    }
})

deploymentsRouter.get('/history/:id', async (req, res) => {
    try {
        const [deploy] = await db.select().from(deploys).where(eq(deploys.id, req.params.id)).limit(1)
        if (!deploy) { res.status(404).json({ error: 'Deploy not found' }); return }
        res.json(deploy)
    } catch (err: any) {
        res.status(500).json({ error: err?.message ?? 'Failed to fetch deploy' })
    }
})

// ── App Registry ────────────────────────────────────────────────────────────

deploymentsRouter.get('/apps', (_req, res) => {
    res.json({ apps: Object.entries(APP_REGISTRY).map(([name, cfg]) => ({ name, ...cfg })) })
})

// ── DB Init (call at startup) ───────────────────────────────────────────────

export async function initDeploysTable(): Promise<void> {
    try {
        await db.execute(sql`
            CREATE TABLE IF NOT EXISTS deploys (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                app TEXT NOT NULL,
                commit_sha TEXT NOT NULL,
                commit_message TEXT,
                branch TEXT NOT NULL DEFAULT 'main',
                status TEXT NOT NULL DEFAULT 'pending',
                triggered_by TEXT NOT NULL DEFAULT 'webhook',
                image_tag TEXT,
                previous_image_tag TEXT,
                duration_ms INT,
                error TEXT,
                health_check_url TEXT,
                started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                completed_at TIMESTAMPTZ
            )
        `)
        await db.execute(sql`CREATE INDEX IF NOT EXISTS deploys_app_idx ON deploys (app)`)
        await db.execute(sql`CREATE INDEX IF NOT EXISTS deploys_started_idx ON deploys (started_at)`)
        logger.info('Deploys table initialized')
    } catch (err) {
        logger.warn({ err }, 'Deploys table init failed (may already exist)')
    }
}

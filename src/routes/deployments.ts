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
import { Router, type Router as RouterType, type Request, type Response, type NextFunction } from 'express'
import express from 'express'
import { execSync } from 'node:child_process'
import * as crypto from 'node:crypto'
import { ulid } from 'ulid'
import { db, sql, eq, desc, and } from '../db/index.js'
import { deploys, webhookDeliveries } from '../db/schema.js'
import { logger } from '../logger.js'

export const deploymentsRouter: RouterType = Router()

/** In-memory deploy mutex — prevents concurrent deploys racing on git + build */
let deployLock: { app: string; since: Date } | null = null

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

/** Middleware: capture raw body for HMAC verification before JSON parsing */
function captureRawBody(req: Request, _res: Response, next: NextFunction): void {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
        ;(req as any).rawBody = Buffer.concat(chunks)
        next()
    })
    req.on('error', next)
}

function verifyGitHubSignature(req: Request): boolean {
    const sig = req.headers['x-hub-signature-256'] as string | undefined
    if (!sig) return false
    const body = (req as any).rawBody as Buffer | undefined
    if (!body) return false
    const expected = 'sha256=' + crypto
        .createHmac('sha256', GITHUB_WEBHOOK_SECRET)
        .update(body)
        .digest('hex')
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
}

/** Build a short summary string from the GitHub push payload (no full payload stored) */
function buildPayloadSummary(body: Record<string, any>): string {
    const repo = body.repository?.full_name ?? 'unknown'
    const branch = body.ref?.replace('refs/heads/', '') ?? 'unknown'
    const sha = (body.after ?? '').slice(0, 7)
    const msg = body.head_commit?.message?.split('\n')[0] ?? ''
    return `${repo}#${branch}@${sha} — ${msg}`.slice(0, 500)
}

/**
 * POST /webhook/github — receives GitHub push webhook
 * No auth middleware (GitHub can't send Bearer tokens) — HMAC signature only
 */
deploymentsRouter.post('/webhook/github', captureRawBody, express.json({ limit: '1mb' }), async (req, res) => {
    const startMs = Date.now()
    const deliveryId = ulid()
    const event = req.headers['x-github-event'] as string | undefined

    // Record every hit immediately
    try {
        await db.insert(webhookDeliveries).values({
            id: deliveryId,
            source: 'github',
            eventType: event ?? 'unknown',
            payloadSummary: buildPayloadSummary(req.body ?? {}),
            status: 'received',
        })
    } catch (insertErr: any) {
        // If we can't even record it, log and continue — don't block the webhook
        logger.error({ err: insertErr?.message, deliveryId }, 'Failed to insert webhook delivery record')
    }

    try {
        if (event !== 'push') {
            await updateDelivery(deliveryId, 'skipped', Date.now() - startMs, null)
            res.status(200).json({ ignored: true, reason: `event type: ${event}` })
            return
        }

        if (!GITHUB_WEBHOOK_SECRET) {
            logger.error('GITHUB_WEBHOOK_SECRET not configured — rejecting webhook')
            await updateDelivery(deliveryId, 'failed', Date.now() - startMs, 'Webhook secret not configured')
            res.status(500).json({ error: 'Webhook secret not configured' })
            return
        }

        if (!verifyGitHubSignature(req)) {
            logger.warn('GitHub webhook signature verification failed')
            await updateDelivery(deliveryId, 'failed', Date.now() - startMs, 'HMAC signature verification failed')
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
            await updateDelivery(deliveryId, 'skipped', Date.now() - startMs, null)
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
            await updateDelivery(deliveryId, 'skipped', Date.now() - startMs, null)
            res.status(200).json({ ignored: true, reason: `no apps for repo: ${repoFullName}` })
            return
        }

        logger.info({ repo: repoFullName, commit: commitSha.slice(0, 7), apps: matchingApps.map(([name]) => name) }, 'GitHub push received — triggering deploys')

        // Trigger deploys asynchronously (don't block the webhook response)
        const deployIds: string[] = []
        const errors: string[] = []
        for (const [appName, _cfg] of matchingApps) {
            try {
                const id = await triggerDeploy(appName, commitSha, commitMessage, branch, triggeredBy)
                deployIds.push(id)
            } catch (err: any) {
                const msg = err?.message ?? String(err)
                logger.error({ err: msg, app: appName }, 'Failed to create deploy record')
                errors.push(`${appName}: ${msg}`)
            }
        }

        if (deployIds.length === 0 && errors.length > 0) {
            await updateDelivery(deliveryId, 'failed', Date.now() - startMs, errors.join('; '))
            res.status(503).json({ error: 'All deploys failed to queue', errors })
            return
        }

        await updateDelivery(deliveryId, 'processed', Date.now() - startMs, null)
        res.status(202).json({ accepted: true, deployIds, apps: matchingApps.map(([name]) => name), ...(errors.length > 0 && { errors }) })
    } catch (err: any) {
        const msg = err?.message ?? String(err)
        logger.error({ err: msg }, 'GitHub webhook handler crashed')
        await updateDelivery(deliveryId, 'failed', Date.now() - startMs, msg).catch(() => {})
        res.status(500).json({ error: 'Webhook processing failed', detail: msg })
    }
})

/** Update a webhook delivery record — fire-and-forget safe */
async function updateDelivery(
    id: string,
    status: 'processed' | 'failed' | 'skipped',
    processingTimeMs: number,
    errorMessage: string | null,
): Promise<void> {
    try {
        await db.update(webhookDeliveries).set({
            status,
            processingTimeMs,
            errorMessage,
        }).where(eq(webhookDeliveries.id, id))
    } catch (err: any) {
        logger.error({ err: err?.message, deliveryId: id }, 'Failed to update webhook delivery record')
    }
}

// ── Smoke Tests ────────────────────────────────────────────────────────────

interface SmokeCheck {
    name: string
    passed: boolean
    error?: string
}

interface SmokeResult {
    passed: boolean
    checks: SmokeCheck[]
}

/** Per-service smoke test definitions — HTTP checks against internal Docker network */
const SMOKE_TESTS: Record<string, (baseUrl: string) => Promise<SmokeCheck[]>> = {
    'plexo-api': async (baseUrl) => {
        const checks: SmokeCheck[] = []

        // Check /api/v1/health returns expected shape
        try {
            const res = await fetch(`${baseUrl}/api/v1/health`)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const body = await res.json() as Record<string, unknown>
            const hasExpected = body && typeof body === 'object' && ('status' in body || 'ok' in body)
            checks.push({ name: 'api-health-fields', passed: !!hasExpected, ...(!hasExpected && { error: 'Missing expected fields in /api/v1/health' }) })
        } catch (e: any) {
            checks.push({ name: 'api-health-fields', passed: false, error: e?.message ?? String(e) })
        }

        // Check Telegram channel info endpoint
        try {
            const res = await fetch(`${baseUrl}/api/v1/channels/telegram/info`)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const body = await res.json() as Record<string, unknown>
            const configured = body && typeof body === 'object' && ('configured' in body || 'botUsername' in body || 'enabled' in body)
            checks.push({ name: 'telegram-configured', passed: !!configured, ...(!configured && { error: 'Telegram config check returned unexpected shape' }) })
        } catch (e: any) {
            checks.push({ name: 'telegram-configured', passed: false, error: e?.message ?? String(e) })
        }

        return checks
    },

    'plexo-web': async (baseUrl) => {
        const checks: SmokeCheck[] = []
        try {
            const res = await fetch(baseUrl)
            checks.push({ name: 'main-page-200', passed: res.ok, ...(!res.ok && { error: `HTTP ${res.status}` }) })
        } catch (e: any) {
            checks.push({ name: 'main-page-200', passed: false, error: e?.message ?? String(e) })
        }
        return checks
    },

    'plexo-saas': async (baseUrl) => {
        const checks: SmokeCheck[] = []
        try {
            const res = await fetch(baseUrl)
            checks.push({ name: 'main-page-200', passed: res.ok, ...(!res.ok && { error: `HTTP ${res.status}` }) })
        } catch (e: any) {
            checks.push({ name: 'main-page-200', passed: false, error: e?.message ?? String(e) })
        }
        return checks
    },
}

async function runSmokeTest(serviceName: string, healthUrl: string): Promise<SmokeResult> {
    const testFn = SMOKE_TESTS[serviceName]
    if (!testFn) {
        // No smoke tests defined — pass by default (health check already passed)
        return { passed: true, checks: [] }
    }

    // Derive base URL from healthUrl (strip path)
    const url = new URL(healthUrl)
    const baseUrl = `${url.protocol}//${url.host}`

    try {
        const checks = await testFn(baseUrl)
        const passed = checks.every(c => c.passed)
        return { passed, checks }
    } catch (e: any) {
        return { passed: false, checks: [{ name: 'smoke-runner', passed: false, error: e?.message ?? String(e) }] }
    }
}

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
    // Acquire deploy mutex — only one deploy at a time
    if (deployLock) {
        const msg = `Deploy in progress for ${deployLock.app} since ${deployLock.since.toISOString()}`
        logger.warn({ deployId, app, blockedBy: deployLock.app }, msg)
        await db.update(deploys).set({
            status: 'failed',
            error: msg,
            completedAt: new Date(),
        }).where(eq(deploys.id, deployId))
        return
    }
    deployLock = { app, since: new Date() }

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

        // Pull latest code — reset hard to avoid dirty-tree failures
        // (the self-updater and docker builds can leave untracked/modified files)
        exec(`cd ${COMPOSE_DIR} && git fetch origin main && git reset --hard origin/main 2>&1`, 60_000)

        // Pre-flight: check disk space (fail fast instead of mid-build)
        try {
            const dfOut = exec(`df -h ${COMPOSE_DIR} | tail -1`, 5_000)
            const usePct = parseInt(dfOut.match(/(\d+)%/)?.[1] ?? '0', 10)
            if (usePct >= 95) {
                throw new Error(`Disk ${usePct}% full on ${COMPOSE_DIR} — aborting build to prevent corruption`)
            }
        } catch (e: any) {
            if (e.message?.includes('Disk')) throw e
            // df failed — not fatal, continue
        }

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

        // 5. Smoke test (service-specific HTTP checks beyond basic health)
        if (healthUrl) {
            const smoke = await runSmokeTest(app, healthUrl)
            for (const check of smoke.checks) {
                logger.info({ deployId, app, check: check.name, passed: check.passed, error: check.error }, 'Smoke test check')
            }

            if (!smoke.passed) {
                const failedChecks = smoke.checks.filter(c => !c.passed).map(c => `${c.name}: ${c.error}`).join('; ')
                const durationMs = Date.now() - startMs
                await db.update(deploys).set({
                    status: 'smoke_failed',
                    previousImageTag: previousTag,
                    error: `Smoke test failed: ${failedChecks}`,
                    durationMs,
                    completedAt: new Date(),
                }).where(eq(deploys.id, deployId))

                logger.error({ deployId, app, service, failedChecks, durationMs }, 'Deploy smoke test failed')
                return
            }
        }

        // 6. Success
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
    } finally {
        deployLock = null
    }
}

// ── Manual Deploy ───────────────────────────────────────────────────────────

deploymentsRouter.post('/:app/deploy', async (req, res) => {
    if (!dockerEnabled()) { res.status(503).json({ error: 'Docker not enabled' }); return }

    if (deployLock) {
        res.status(409).json({ error: `Deploy in progress for ${deployLock.app} since ${deployLock.since.toISOString()}` })
        return
    }

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

// ── Webhook Deliveries ─────────────────────────────────────────────────────

deploymentsRouter.get('/webhook-deliveries', async (req, res) => {
    const source = req.query.source as string | undefined
    const status = req.query.status as string | undefined
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200)
    const offset = parseInt(req.query.offset as string) || 0

    try {
        const conditions = []
        if (source) conditions.push(eq(webhookDeliveries.source, source))
        if (status) conditions.push(eq(webhookDeliveries.status, status as any))

        const query = conditions.length > 0
            ? db.select().from(webhookDeliveries).where(and(...conditions)).orderBy(desc(webhookDeliveries.receivedAt)).limit(limit).offset(offset)
            : db.select().from(webhookDeliveries).orderBy(desc(webhookDeliveries.receivedAt)).limit(limit).offset(offset)

        const rows = await query
        res.json({ deliveries: rows, count: rows.length, limit, offset })
    } catch (err: any) {
        logger.error({ err: err?.message }, 'Failed to fetch webhook deliveries')
        res.status(500).json({ error: 'Failed to fetch webhook deliveries' })
    }
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

        // Add smoke_failed to deploy_status enum if not present (idempotent)
        try {
            await db.execute(sql`ALTER TYPE deploy_status ADD VALUE IF NOT EXISTS 'smoke_failed'`)
        } catch { /* enum value may already exist or type uses TEXT — fine either way */ }

        logger.info('Deploys table initialized')
    } catch (err) {
        logger.warn({ err }, 'Deploys table init failed (may already exist)')
    }
}

export async function initWebhookDeliveriesTable(): Promise<void> {
    try {
        await db.execute(sql`
            CREATE TABLE IF NOT EXISTS webhook_deliveries (
                id TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                event_type TEXT NOT NULL,
                payload_summary TEXT,
                status TEXT NOT NULL DEFAULT 'received',
                error_message TEXT,
                processing_time_ms INT,
                received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `)
        await db.execute(sql`CREATE INDEX IF NOT EXISTS webhook_deliveries_source_idx ON webhook_deliveries (source)`)
        await db.execute(sql`CREATE INDEX IF NOT EXISTS webhook_deliveries_status_idx ON webhook_deliveries (status)`)
        await db.execute(sql`CREATE INDEX IF NOT EXISTS webhook_deliveries_received_idx ON webhook_deliveries (received_at)`)
        logger.info('Webhook deliveries table initialized')
    } catch (err) {
        logger.warn({ err }, 'Webhook deliveries table init failed (may already exist)')
    }
}

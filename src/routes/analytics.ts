import { Router, type Router as RouterType, type Request } from 'express'
import { db, analyticsEvents, errorReports, sql, eq, and, desc, gte } from '../db/index.js'
import { logger } from '../logger.js'

// ── Table init (CREATE TABLE IF NOT EXISTS) ─────────────────────

export async function initAnalyticsTables(): Promise<void> {
    await db.execute(sql`
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'error_report_status') THEN
                CREATE TYPE error_report_status AS ENUM ('unresolved', 'resolved', 'ignored');
            END IF;
        END $$
    `)
    await db.execute(sql`
        CREATE TABLE IF NOT EXISTS analytics_events (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            instance_id TEXT NOT NULL,
            app TEXT NOT NULL DEFAULT 'plexo',
            event_name TEXT NOT NULL,
            properties JSONB NOT NULL DEFAULT '{}',
            plexo_version TEXT,
            node_version TEXT,
            received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `)
    await db.execute(sql`CREATE INDEX IF NOT EXISTS analytics_events_instance_received_idx ON analytics_events (instance_id, received_at)`)
    await db.execute(sql`CREATE INDEX IF NOT EXISTS analytics_events_name_idx ON analytics_events (event_name)`)
    await db.execute(sql`CREATE INDEX IF NOT EXISTS analytics_events_received_idx ON analytics_events (received_at)`)

    await db.execute(sql`
        CREATE TABLE IF NOT EXISTS error_reports (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            instance_id TEXT NOT NULL,
            app TEXT NOT NULL DEFAULT 'plexo',
            fingerprint TEXT NOT NULL,
            message TEXT NOT NULL,
            stack_trace TEXT,
            context JSONB NOT NULL DEFAULT '{}',
            deploy_id TEXT,
            status error_report_status NOT NULL DEFAULT 'unresolved',
            assigned_to TEXT,
            resolved_at TIMESTAMPTZ,
            first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            occurrence_count INT NOT NULL DEFAULT 1
        )
    `)
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS error_reports_instance_fingerprint_idx ON error_reports (instance_id, fingerprint)`)
    await db.execute(sql`CREATE INDEX IF NOT EXISTS error_reports_status_idx ON error_reports (status)`)
    await db.execute(sql`CREATE INDEX IF NOT EXISTS error_reports_last_seen_idx ON error_reports (last_seen_at)`)

    await db.execute(sql`
        CREATE TABLE IF NOT EXISTS feature_flags (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            key TEXT NOT NULL UNIQUE,
            name TEXT,
            description TEXT,
            active BOOLEAN NOT NULL DEFAULT false,
            rollout_percentage INT NOT NULL DEFAULT 100,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `)

    logger.info('Analytics & error tables initialized')
}

// ── Allowlists (must match Plexo's telemetry/router.ts) ────────

const ALLOWED_EVENT_NAMES = new Set([
    'plexo_installed', 'plexo_agent_run', 'plexo_skill_installed',
    'plexo_skill_run', 'plexo_mcp_connected', 'plexo_task_completed',
    'plexo_task_failed', 'plexo_extension_installed',
    'plexo_inference_gateway_call', 'plexo_onboarding_completed',
    // v2 canonical events
    'onboarding_started', 'onboarding_completed', 'extension_installed',
    'agent_run_started', 'agent_run_completed', 'agent_run_failed',
    'inference_invoked', 'settings_changed', 'connection_installed',
    'session_started', 'instance_heartbeat',
])

const ALLOWED_PROPERTIES = new Set([
    'instance_uuid', 'model', 'provider', 'duration_ms', 'success',
    'skill_name', 'extension_name', 'task_type', 'error_code',
    'latency_ms', 'source', 'model_family', 'duration_bucket',
    'cost_bucket', 'step_count_bucket', 'failure_type',
    'task_source', 'token_count_bucket', 'latency_bucket',
    'setting_key', 'connection_type', 'plexo_version', 'node_version',
])

// ── Rate limiter ────────────────────────────────────────────────

const rateBuckets = new Map<string, { events: number; errors: number; resetAt: number }>()
const EVENT_LIMIT = 100   // per minute
const ERROR_LIMIT = 20    // per minute

function checkRateLimit(instanceId: string, type: 'events' | 'errors'): boolean {
    const now = Date.now()
    let bucket = rateBuckets.get(instanceId)
    if (!bucket || bucket.resetAt < now) {
        bucket = { events: 0, errors: 0, resetAt: now + 60_000 }
        rateBuckets.set(instanceId, bucket)
    }
    const limit = type === 'events' ? EVENT_LIMIT : ERROR_LIMIT
    if (bucket[type] >= limit) return false
    bucket[type]++
    return true
}

// Clean stale buckets every 5 minutes
setInterval(() => {
    const now = Date.now()
    for (const [key, bucket] of rateBuckets) {
        if (bucket.resetAt < now) rateBuckets.delete(key)
    }
}, 300_000).unref()

// ── Ingest routes (lightweight auth) ────────────────────────────

export const ingestRouter: RouterType = Router()

ingestRouter.post('/events', async (req: Request, res) => {
    const instanceId = (req as unknown as Record<string, unknown>).instanceId as string
    try {
        const { event_name, properties, plexo_version, node_version } = req.body as {
            event_name?: string; properties?: Record<string, unknown>
            plexo_version?: string; node_version?: string
        }

        if (!event_name || !ALLOWED_EVENT_NAMES.has(event_name)) {
            res.status(400).json({ error: { code: 'INVALID_EVENT', message: `Unknown event: ${event_name}` } })
            return
        }

        if (!checkRateLimit(instanceId, 'events')) {
            res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many events' } })
            return
        }

        // Strip unknown properties
        const clean: Record<string, unknown> = {}
        if (properties) {
            for (const [k, v] of Object.entries(properties)) {
                if (ALLOWED_PROPERTIES.has(k)) clean[k] = v
            }
        }

        await db.insert(analyticsEvents).values({
            instanceId,
            eventName: event_name,
            properties: clean,
            plexoVersion: plexo_version,
            nodeVersion: node_version,
        })

        res.status(201).json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'analytics ingest failed')
        res.status(500).json({ error: { code: 'INTERNAL', message: 'Ingest failed' } })
    }
})

ingestRouter.post('/errors', async (req: Request, res) => {
    const instanceId = (req as unknown as Record<string, unknown>).instanceId as string
    try {
        const { fingerprint, message, stack_trace, context, deploy_id } = req.body as {
            fingerprint?: string; message?: string; stack_trace?: string
            context?: Record<string, unknown>; deploy_id?: string
        }

        if (!fingerprint || !message) {
            res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'fingerprint and message required' } })
            return
        }

        if (!checkRateLimit(instanceId, 'errors')) {
            res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many errors' } })
            return
        }

        await db.insert(errorReports).values({
            instanceId,
            fingerprint,
            message,
            stackTrace: stack_trace,
            context: context ?? {},
            deployId: deploy_id,
        }).onConflictDoUpdate({
            target: [errorReports.instanceId, errorReports.fingerprint],
            set: {
                lastSeenAt: sql`NOW()`,
                occurrenceCount: sql`${errorReports.occurrenceCount} + 1`,
            },
        })

        res.status(201).json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'error ingest failed')
        res.status(500).json({ error: { code: 'INTERNAL', message: 'Error ingest failed' } })
    }
})

// ── Read routes (behind cmdCenterAuth) ──────────────────────────

export const readRouter: RouterType = Router()

readRouter.get('/events', async (req, res) => {
    try {
        const range = (req.query.range as string) ?? '7d'
        const eventName = req.query.event_name as string | undefined
        const instanceId = req.query.instance_id as string | undefined
        const limit = Math.min(parseInt(req.query.limit as string) || 500, 1000)

        const days = range.endsWith('d') ? parseInt(range) : 7
        const since = new Date(Date.now() - days * 86_400_000)

        const conditions = [gte(analyticsEvents.receivedAt, since)]
        if (eventName) conditions.push(eq(analyticsEvents.eventName, eventName))
        if (instanceId) conditions.push(eq(analyticsEvents.instanceId, instanceId))

        const rows = await db.select()
            .from(analyticsEvents)
            .where(and(...conditions))
            .orderBy(desc(analyticsEvents.receivedAt))
            .limit(limit)

        res.json({ data: rows, count: rows.length })
    } catch (err) {
        logger.error({ err }, 'analytics events query failed')
        res.status(500).json({ error: { code: 'INTERNAL', message: 'Query failed' } })
    }
})

readRouter.get('/errors', async (req, res) => {
    try {
        const status = req.query.status as string | undefined
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200)

        const conditions = []
        if (status) conditions.push(eq(errorReports.status, status as 'unresolved' | 'resolved' | 'ignored'))

        const rows = await db.select()
            .from(errorReports)
            .where(conditions.length ? and(...conditions) : undefined)
            .orderBy(desc(errorReports.lastSeenAt))
            .limit(limit)

        res.json({ data: rows, count: rows.length })
    } catch (err) {
        logger.error({ err }, 'errors query failed')
        res.status(500).json({ error: { code: 'INTERNAL', message: 'Query failed' } })
    }
})

readRouter.get('/summary', async (req, res) => {
    try {
        const now = new Date()
        const day = new Date(now.getTime() - 86_400_000)
        const week = new Date(now.getTime() - 7 * 86_400_000)

        const [events24h] = await db.select({ count: sql<number>`count(*)` })
            .from(analyticsEvents).where(gte(analyticsEvents.receivedAt, day))
        const [events7d] = await db.select({ count: sql<number>`count(*)` })
            .from(analyticsEvents).where(gte(analyticsEvents.receivedAt, week))
        const [errorsUnresolved] = await db.select({ count: sql<number>`count(*)` })
            .from(errorReports).where(eq(errorReports.status, 'unresolved'))
        const [instances] = await db.select({ count: sql<number>`count(DISTINCT ${analyticsEvents.instanceId})` })
            .from(analyticsEvents).where(gte(analyticsEvents.receivedAt, week))

        res.json({
            events24h: Number(events24h?.count ?? 0),
            events7d: Number(events7d?.count ?? 0),
            errorsUnresolved: Number(errorsUnresolved?.count ?? 0),
            activeInstances7d: Number(instances?.count ?? 0),
        })
    } catch (err) {
        logger.error({ err }, 'analytics summary failed')
        res.status(500).json({ error: { code: 'INTERNAL', message: 'Summary failed' } })
    }
})

readRouter.get('/instances', async (req, res) => {
    try {
        const rows = await db.select({
            instanceId: analyticsEvents.instanceId,
            lastSeen: sql<Date>`MAX(${analyticsEvents.receivedAt})`,
            eventCount: sql<number>`count(*)`,
        })
            .from(analyticsEvents)
            .groupBy(analyticsEvents.instanceId)
            .orderBy(sql`MAX(${analyticsEvents.receivedAt}) DESC`)
            .limit(100)

        res.json({ data: rows })
    } catch (err) {
        logger.error({ err }, 'analytics instances query failed')
        res.status(500).json({ error: { code: 'INTERNAL', message: 'Query failed' } })
    }
})

readRouter.post('/errors/:id/resolve', async (req, res) => {
    try {
        await db.update(errorReports)
            .set({ status: 'resolved', resolvedAt: new Date() })
            .where(eq(errorReports.id, req.params.id))
        res.json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'error resolve failed')
        res.status(500).json({ error: { code: 'INTERNAL', message: 'Resolve failed' } })
    }
})

readRouter.post('/errors/:id/assign', async (req, res) => {
    try {
        const { assignee } = req.body as { assignee?: string }
        await db.update(errorReports)
            .set({ assignedTo: assignee ?? null })
            .where(eq(errorReports.id, req.params.id))
        res.json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'error assign failed')
        res.status(500).json({ error: { code: 'INTERNAL', message: 'Assign failed' } })
    }
})

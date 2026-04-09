// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import { ulid } from 'ulid'
import { db, issueFlags, eq, and, desc, sql, gt } from '../db/index.js'
import { logger } from '../logger.js'

export const flagsRouter: RouterType = Router()
export const flagsIngestRouter: RouterType = Router()

const VALID_SEVERITIES = ['critical', 'warning', 'info'] as const
const VALID_CATEGORIES = [
    'delivery_failure', 'service_outage', 'error_spike', 'empty_response',
    'duplicate_response', 'timeout', 'disk_alert', 'webhook_failure',
] as const
const VALID_STATUSES = ['open', 'acknowledged', 'resolved', 'auto_resolved'] as const

type Severity = typeof VALID_SEVERITIES[number]
type Category = typeof VALID_CATEGORIES[number]
type Status = typeof VALID_STATUSES[number]

// ── Shared flag creation logic (dedup + insert) ───────────────────────────

export async function createFlag(params: {
    severity: Severity
    category: Category
    title: string
    detail: string
    source_service: string
    source_id?: string | null
    metadata?: Record<string, unknown> | null
}): Promise<{ id: string; deduplicated: boolean }> {
    const dedupWindow = new Date(Date.now() - 30 * 60 * 1000) // 30 minutes

    // Check for existing open flag with same category+source_service+title within window
    const [existing] = await db.select()
        .from(issueFlags)
        .where(and(
            eq(issueFlags.category, params.category),
            eq(issueFlags.sourceService, params.source_service),
            eq(issueFlags.title, params.title),
            eq(issueFlags.status, 'open'),
            gt(issueFlags.createdAt, dedupWindow),
        ))
        .limit(1)

    if (existing) {
        // Increment occurrence count in metadata
        const meta = (existing.metadata as Record<string, unknown>) ?? {}
        const count = ((meta.occurrence_count as number) ?? 1) + 1
        await db.update(issueFlags)
            .set({ metadata: { ...meta, occurrence_count: count } })
            .where(eq(issueFlags.id, existing.id))
        return { id: existing.id, deduplicated: true }
    }

    const id = ulid()
    await db.insert(issueFlags).values({
        id,
        severity: params.severity,
        category: params.category,
        title: params.title,
        detail: params.detail,
        sourceService: params.source_service,
        sourceId: params.source_id ?? null,
        metadata: params.metadata ? { ...params.metadata, occurrence_count: 1 } : { occurrence_count: 1 },
    })

    return { id, deduplicated: false }
}

// ── POST /flags — create flag ─────────────────────────────────────────────

flagsRouter.post('/', async (req, res) => {
    try {
        const { severity, category, title, detail, source_service, source_id, metadata } = req.body as {
            severity?: string; category?: string; title?: string; detail?: string
            source_service?: string; source_id?: string; metadata?: Record<string, unknown>
        }

        if (!severity || !VALID_SEVERITIES.includes(severity as Severity)) {
            res.status(400).json({ error: { code: 'INVALID_SEVERITY', message: `severity must be one of: ${VALID_SEVERITIES.join(', ')}` } })
            return
        }
        if (!category || !VALID_CATEGORIES.includes(category as Category)) {
            res.status(400).json({ error: { code: 'INVALID_CATEGORY', message: `category must be one of: ${VALID_CATEGORIES.join(', ')}` } })
            return
        }
        if (!title?.trim()) {
            res.status(400).json({ error: { code: 'MISSING_TITLE', message: 'title required' } })
            return
        }
        if (!detail?.trim()) {
            res.status(400).json({ error: { code: 'MISSING_DETAIL', message: 'detail required' } })
            return
        }
        if (!source_service?.trim()) {
            res.status(400).json({ error: { code: 'MISSING_SOURCE', message: 'source_service required' } })
            return
        }

        const result = await createFlag({
            severity: severity as Severity,
            category: category as Category,
            title: title.trim(),
            detail: detail.trim(),
            source_service: source_service.trim(),
            source_id: source_id ?? null,
            metadata: metadata ?? null,
        })

        res.status(result.deduplicated ? 200 : 201).json(result)
    } catch (err) {
        logger.error({ err }, 'flags: create failed')
        res.status(500).json({ error: { code: 'INTERNAL', message: 'Create failed' } })
    }
})

// ── GET /flags — list flags ───────────────────────────────────────────────

flagsRouter.get('/', async (req, res) => {
    try {
        const status = (req.query.status as string) ?? 'open'
        const severity = req.query.severity as string | undefined
        const category = req.query.category as string | undefined
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200)
        const offset = parseInt(req.query.offset as string) || 0

        const conditions = []
        if (status && VALID_STATUSES.includes(status as Status)) {
            conditions.push(eq(issueFlags.status, status as Status))
        }
        if (severity && VALID_SEVERITIES.includes(severity as Severity)) {
            conditions.push(eq(issueFlags.severity, severity as Severity))
        }
        if (category && VALID_CATEGORIES.includes(category as Category)) {
            conditions.push(eq(issueFlags.category, category as Category))
        }

        const where = conditions.length > 0 ? and(...conditions) : undefined

        const rows = await db.select()
            .from(issueFlags)
            .where(where)
            .orderBy(desc(issueFlags.createdAt))
            .limit(limit)
            .offset(offset)

        res.json({ data: rows })
    } catch (err) {
        logger.error({ err }, 'flags: list failed')
        res.status(500).json({ error: { code: 'INTERNAL', message: 'List failed' } })
    }
})

// ── PATCH /flags/:id — update flag ────────────────────────────────────────

flagsRouter.patch('/:id', async (req, res) => {
    try {
        const { status, resolved_by } = req.body as {
            status?: string; resolved_by?: string
        }

        const update: Record<string, unknown> = {}
        if (status && VALID_STATUSES.includes(status as Status)) {
            update.status = status
            if (status === 'resolved' || status === 'auto_resolved') {
                update.resolvedAt = new Date()
                if (resolved_by) update.resolvedBy = resolved_by
            }
        }
        if (resolved_by !== undefined) update.resolvedBy = resolved_by

        if (Object.keys(update).length === 0) {
            res.status(400).json({ error: { code: 'NO_UPDATES', message: 'No valid fields to update' } })
            return
        }

        const [row] = await db.update(issueFlags)
            .set(update)
            .where(eq(issueFlags.id, req.params.id))
            .returning()

        if (!row) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Flag not found' } })
            return
        }

        res.json(row)
    } catch (err) {
        logger.error({ err }, 'flags: update failed')
        res.status(500).json({ error: { code: 'INTERNAL', message: 'Update failed' } })
    }
})

// ── Ingest endpoint for Plexo ─────────────────────────────────────────────

flagsIngestRouter.post('/', async (req, res) => {
    try {
        const flags = Array.isArray(req.body) ? req.body : [req.body]
        const results: { id: string; deduplicated: boolean }[] = []

        for (const flag of flags) {
            const { severity, category, title, detail, source_service, source_id, metadata } = flag as {
                severity?: string; category?: string; title?: string; detail?: string
                source_service?: string; source_id?: string; metadata?: Record<string, unknown>
            }

            if (!severity || !VALID_SEVERITIES.includes(severity as Severity)) continue
            if (!category || !VALID_CATEGORIES.includes(category as Category)) continue
            if (!title?.trim() || !detail?.trim() || !source_service?.trim()) continue

            const result = await createFlag({
                severity: severity as Severity,
                category: category as Category,
                title: title.trim(),
                detail: detail.trim(),
                source_service: source_service.trim(),
                source_id: source_id ?? null,
                metadata: metadata ?? null,
            })

            results.push(result)
        }

        res.status(201).json({ accepted: results.length, results })
    } catch (err) {
        logger.error({ err }, 'flags: ingest failed')
        res.status(500).json({ error: { code: 'INTERNAL', message: 'Ingest failed' } })
    }
})

// ── Table init ────────────────────────────────────────────────────────────

export async function initIssueFlagsTable(): Promise<void> {
    try {
        await db.execute(sql`
            DO $$ BEGIN
                CREATE TYPE issue_flag_severity AS ENUM ('critical', 'warning', 'info');
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$
        `)
        await db.execute(sql`
            DO $$ BEGIN
                CREATE TYPE issue_flag_category AS ENUM (
                    'delivery_failure', 'service_outage', 'error_spike', 'empty_response',
                    'duplicate_response', 'timeout', 'disk_alert', 'webhook_failure'
                );
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$
        `)
        await db.execute(sql`
            DO $$ BEGIN
                CREATE TYPE issue_flag_status AS ENUM ('open', 'acknowledged', 'resolved', 'auto_resolved');
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$
        `)

        await db.execute(sql`
            CREATE TABLE IF NOT EXISTS issue_flags (
                id TEXT PRIMARY KEY,
                severity issue_flag_severity NOT NULL,
                category issue_flag_category NOT NULL,
                title TEXT NOT NULL,
                detail TEXT NOT NULL,
                source_service TEXT NOT NULL,
                source_id TEXT,
                status issue_flag_status NOT NULL DEFAULT 'open',
                resolved_by TEXT,
                resolved_at TIMESTAMPTZ,
                metadata JSONB,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `)
        await db.execute(sql`CREATE INDEX IF NOT EXISTS issue_flags_severity_idx ON issue_flags (severity)`)
        await db.execute(sql`CREATE INDEX IF NOT EXISTS issue_flags_category_idx ON issue_flags (category)`)
        await db.execute(sql`CREATE INDEX IF NOT EXISTS issue_flags_status_idx ON issue_flags (status)`)
        await db.execute(sql`CREATE INDEX IF NOT EXISTS issue_flags_created_idx ON issue_flags (created_at)`)
        await db.execute(sql`CREATE INDEX IF NOT EXISTS issue_flags_source_service_idx ON issue_flags (source_service)`)

        logger.info('Issue flags table initialized')
    } catch (err) {
        logger.warn({ err }, 'Issue flags table init failed (may already exist)')
    }
}

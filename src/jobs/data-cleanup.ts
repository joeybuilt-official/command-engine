// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Data Cleanup Job
 *
 * Runs every 6 hours. Deletes time-series rows past their retention window.
 * Prevents unbounded table growth for analytics, errors, health, metrics, and webhooks.
 */
import { db, sql } from '../db/index.js'
import { logger } from '../logger.js'

const CLEANUP_INTERVAL = 6 * 60 * 60 * 1000 // 6 hours

interface CleanupTarget {
    table: string
    column: string
    retentionDays: number
}

const TARGETS: CleanupTarget[] = [
    { table: 'analytics_events',       column: 'received_at',  retentionDays: 90 },
    { table: 'error_reports',          column: 'last_seen_at', retentionDays: 90 },
    { table: 'service_health_events',  column: 'recorded_at',  retentionDays: 30 },
    { table: 'resource_metrics',       column: 'recorded_at',  retentionDays: 30 },
    { table: 'webhook_deliveries',     column: 'received_at',  retentionDays: 30 },
]

let _timer: ReturnType<typeof setInterval> | null = null

async function runCleanup(): Promise<void> {
    logger.info('data-cleanup: starting')

    for (const target of TARGETS) {
        try {
            const result = await db.execute(
                sql.raw(
                    `DELETE FROM ${target.table} WHERE ${target.column} < NOW() - INTERVAL '${target.retentionDays} days'`
                ),
            )
            const deleted = (result as any)?.rowCount ?? (result as any)?.length ?? 0
            if (deleted > 0) {
                logger.info({ table: target.table, deleted, retentionDays: target.retentionDays }, 'data-cleanup: purged old rows')
            }
        } catch (err: any) {
            // Table may not exist yet — not fatal
            logger.warn({ err: err?.message, table: target.table }, 'data-cleanup: failed to clean table')
        }
    }

    logger.info('data-cleanup: complete')
}

export async function startDataCleanup(): Promise<void> {
    logger.info({ intervalMs: CLEANUP_INTERVAL }, 'Starting data cleanup job')

    // First run after 30s (let DB init finish)
    setTimeout(async () => {
        await runCleanup()
        _timer = setInterval(runCleanup, CLEANUP_INTERVAL)
    }, 30_000)
}

export function stopDataCleanup(): void {
    if (_timer) {
        clearInterval(_timer)
        _timer = null
    }
}

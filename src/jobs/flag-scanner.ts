// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Flag Scanner — runs every 5 minutes
 *
 * Scans webhook_deliveries, service_health_events, and resource_metrics
 * for anomalies and creates/escalates/auto-resolves issue flags.
 */
import { db, sql, eq, and, gt, issueFlags } from '../db/index.js'
import { webhookDeliveries, serviceHealthEvents, resourceMetrics } from '../db/schema.js'
import { createFlag } from '../routes/flags.js'
import { logger } from '../logger.js'

const SCAN_INTERVAL = 5 * 60 * 1000 // 5 minutes
let _timer: ReturnType<typeof setInterval> | null = null

// ── Webhook failure scanner ───────────────────────────────────────────────

async function scanWebhookFailures(): Promise<void> {
    const window = new Date(Date.now() - 15 * 60 * 1000) // 15 min

    const rows = await db.select({
        source: webhookDeliveries.source,
        failCount: sql<number>`count(*)::int`,
    })
        .from(webhookDeliveries)
        .where(and(
            eq(webhookDeliveries.status, 'failed'),
            gt(webhookDeliveries.receivedAt, window),
        ))
        .groupBy(webhookDeliveries.source)

    for (const row of rows) {
        if (row.failCount > 3) {
            const severity = row.failCount > 10 ? 'critical' : 'warning'
            await createFlag({
                severity,
                category: 'webhook_failure',
                title: `${row.source} webhook failed ${row.failCount} times in 15 min`,
                detail: `Webhook deliveries from ${row.source} have ${row.failCount} failures in the last 15 minutes. Check the service health and webhook endpoint availability.`,
                source_service: 'command-engine',
                metadata: { source: row.source, fail_count: row.failCount, window_minutes: 15 },
            })
        }
    }
}

// ── Service outage scanner ────────────────────────────────────────────────

async function scanServiceOutages(): Promise<void> {
    // Get latest status per service
    const rows = await db.execute(sql`
        SELECT DISTINCT ON (service_name) service_name, status, error_message, recorded_at
        FROM service_health_events
        ORDER BY service_name, recorded_at DESC
    `) as any[]

    for (const row of rows) {
        if (row.status === 'down') {
            await createFlag({
                severity: 'critical',
                category: 'service_outage',
                title: `${row.service_name} is down`,
                detail: `Service ${row.service_name} reported status 'down'. Error: ${row.error_message ?? 'none'}. Last event at ${row.recorded_at}.`,
                source_service: 'command-engine',
                source_id: null,
                metadata: { service: row.service_name, error: row.error_message },
            })
        } else if (row.status === 'unhealthy') {
            await createFlag({
                severity: 'warning',
                category: 'service_outage',
                title: `${row.service_name} is unhealthy`,
                detail: `Service ${row.service_name} reported status 'unhealthy'. Error: ${row.error_message ?? 'none'}.`,
                source_service: 'command-engine',
                source_id: null,
                metadata: { service: row.service_name, error: row.error_message },
            })
        }
    }

    // Auto-resolve service_outage flags where service is now healthy
    const healthyServices = rows
        .filter((r: any) => r.status === 'healthy')
        .map((r: any) => r.service_name)

    if (healthyServices.length > 0) {
        const openOutageFlags = await db.select()
            .from(issueFlags)
            .where(and(
                eq(issueFlags.category, 'service_outage'),
                eq(issueFlags.status, 'open'),
            ))

        for (const flag of openOutageFlags) {
            const meta = flag.metadata as Record<string, unknown> | null
            const flagService = meta?.service as string
            if (flagService && healthyServices.includes(flagService)) {
                await db.update(issueFlags)
                    .set({ status: 'auto_resolved', resolvedBy: 'auto', resolvedAt: new Date() })
                    .where(eq(issueFlags.id, flag.id))
                logger.info({ flagId: flag.id, service: flagService }, 'flag-scanner: auto-resolved service outage')
            }
        }
    }
}

// ── Disk alert scanner ────────────────────────────────────────────────────

async function scanDiskAlerts(): Promise<void> {
    const [latest] = await db.select()
        .from(resourceMetrics)
        .where(eq(resourceMetrics.metricType, 'disk_usage'))
        .orderBy(sql`recorded_at DESC`)
        .limit(1)

    if (!latest) return

    const percent = latest.valuePercent

    if (percent >= 90) {
        await createFlag({
            severity: 'critical',
            category: 'disk_alert',
            title: `Disk usage at ${percent}%`,
            detail: `Root filesystem disk usage is ${percent}% (raw: ${latest.valueRaw}). Immediate action required — clean up docker images, logs, or expand storage.`,
            source_service: 'command-engine',
            source_id: latest.id,
            metadata: { percent, raw: latest.valueRaw },
        })
    } else if (percent >= 85) {
        await createFlag({
            severity: 'warning',
            category: 'disk_alert',
            title: `Disk usage at ${percent}%`,
            detail: `Root filesystem disk usage is ${percent}% (raw: ${latest.valueRaw}). Consider cleaning up unused resources.`,
            source_service: 'command-engine',
            source_id: latest.id,
            metadata: { percent, raw: latest.valueRaw },
        })
    }

    // Auto-resolve disk alerts if below 85%
    if (percent < 85) {
        const openDiskFlags = await db.select()
            .from(issueFlags)
            .where(and(
                eq(issueFlags.category, 'disk_alert'),
                eq(issueFlags.status, 'open'),
            ))

        for (const flag of openDiskFlags) {
            await db.update(issueFlags)
                .set({ status: 'auto_resolved', resolvedBy: 'auto', resolvedAt: new Date() })
                .where(eq(issueFlags.id, flag.id))
            logger.info({ flagId: flag.id }, 'flag-scanner: auto-resolved disk alert')
        }
    }
}

// ── Severity escalation ───────────────────────────────────────────────────

async function escalateRepeatedFlags(): Promise<void> {
    // Find open warning flags with occurrence_count > 5 — escalate to critical
    const openWarnings = await db.select()
        .from(issueFlags)
        .where(and(
            eq(issueFlags.severity, 'warning'),
            eq(issueFlags.status, 'open'),
        ))

    for (const flag of openWarnings) {
        const meta = flag.metadata as Record<string, unknown> | null
        const count = (meta?.occurrence_count as number) ?? 1
        if (count > 5) {
            await db.update(issueFlags)
                .set({ severity: 'critical', metadata: { ...meta, escalated_from: 'warning', escalated_at: new Date().toISOString() } })
                .where(eq(issueFlags.id, flag.id))
            logger.warn({ flagId: flag.id, count }, 'flag-scanner: escalated warning to critical')
        }
    }
}

// ── Main scan loop ────────────────────────────────────────────────────────

async function scan(): Promise<void> {
    try {
        await Promise.all([
            scanWebhookFailures(),
            scanServiceOutages(),
            scanDiskAlerts(),
        ])
        await escalateRepeatedFlags()
    } catch (err) {
        logger.error({ err }, 'flag-scanner: scan failed')
    }
}

// ── Public API ────────────────────────────────────────────────────────────

export async function startFlagScanner(): Promise<void> {
    logger.info({ interval: SCAN_INTERVAL }, 'Starting flag scanner')

    // First scan after 30s (let tables init)
    setTimeout(async () => {
        await scan()
        _timer = setInterval(scan, SCAN_INTERVAL)
    }, 30_000)
}

export function stopFlagScanner(): void {
    if (_timer) {
        clearInterval(_timer)
        _timer = null
    }
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Infrastructure Health Monitor
 *
 * Polls docker container states and disk usage every 60s.
 * Only persists CHANGES — not every poll. Events go to Postgres
 * so cascade failures have a permanent audit trail.
 */
import { execSync } from 'node:child_process'
import { ulid } from 'ulid'
import { db, sql } from '../db/index.js'
import { serviceHealthEvents, resourceMetrics } from '../db/schema.js'
import { logger } from '../logger.js'

const POLL_INTERVAL = 60_000
const DISK_CHANGE_THRESHOLD = 2 // record if changed by >2%
const DISK_ALERT_THRESHOLDS = [85, 90, 95]

interface ContainerState {
    status: 'healthy' | 'unhealthy' | 'down' | 'starting'
    raw: string
}

/** Last known state per container — lives in memory, seeded from DB on start */
const lastKnownState: Map<string, string> = new Map()
let lastDiskPercent: number | null = null
let _timer: ReturnType<typeof setInterval> | null = null

function exec(cmd: string, timeout = 10_000): string {
    return execSync(cmd, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 }).trim()
}

// ── Docker Container Polling ───────────────────────────────────────────────

interface DockerPsEntry {
    Names: string
    State: string
    Status: string
}

function parseContainerStatus(entry: DockerPsEntry): ContainerState | null {
    const state = entry.State?.toLowerCase() ?? ''
    const status = entry.Status?.toLowerCase() ?? ''

    if (state === 'running' && status.includes('(healthy)')) {
        return { status: 'healthy', raw: entry.Status }
    }
    if (state === 'running' && status.includes('(unhealthy)')) {
        return { status: 'unhealthy', raw: entry.Status }
    }
    if (state === 'running' && status.includes('starting')) {
        return { status: 'starting', raw: entry.Status }
    }
    if (state === 'running') {
        return { status: 'healthy', raw: entry.Status }
    }
    // One-shot/init containers that exit cleanly — not a failure, skip alarming.
    if (state === 'exited' && status.includes('exited (0)')) {
        return null
    }
    // exited (non-zero), dead, created, paused, etc.
    return { status: 'down', raw: entry.Status }
}

async function pollContainers(): Promise<void> {
    let raw: string
    try {
        raw = exec('docker ps -a --format json')
    } catch (err: any) {
        logger.error({ err: err?.message }, 'health-monitor: docker ps failed')
        return
    }

    const entries: DockerPsEntry[] = raw
        .split('\n')
        .filter(Boolean)
        .map(line => {
            try { return JSON.parse(line) } catch { return null }
        })
        .filter((e): e is DockerPsEntry => e !== null)

    const now = new Date()
    const seenNames = new Set<string>()

    for (const entry of entries) {
        const name = entry.Names
        seenNames.add(name)
        const parsed = parseContainerStatus(entry)
        if (!parsed) {
            // Clean exit (0): mark as down so later prune doesn't re-alarm
            lastKnownState.set(name, 'down')
            continue
        }
        const { status, raw: rawStatus } = parsed
        const previous = lastKnownState.get(name)

        if (previous === status) continue // no change

        // State changed — record it
        try {
            await db.insert(serviceHealthEvents).values({
                id: ulid(),
                serviceName: name,
                status,
                previousStatus: previous ?? null,
                errorMessage: status === 'down' || status === 'unhealthy' ? rawStatus : null,
                metadata: { dockerState: entry.State, dockerStatus: entry.Status },
                recordedAt: now,
            })
            logger.warn(
                { service: name, from: previous ?? 'unknown', to: status },
                `health-monitor: ${name} ${previous ?? 'unknown'} -> ${status}`,
            )
        } catch (err: any) {
            logger.error({ err: err?.message, service: name }, 'health-monitor: failed to insert health event')
        }

        lastKnownState.set(name, status)
    }

    // Detect containers that disappeared (were removed)
    for (const [name, prevStatus] of lastKnownState) {
        if (!seenNames.has(name) && prevStatus !== 'down') {
            try {
                await db.insert(serviceHealthEvents).values({
                    id: ulid(),
                    serviceName: name,
                    status: 'down',
                    previousStatus: prevStatus,
                    errorMessage: 'Container no longer present in docker ps',
                    recordedAt: now,
                })
                logger.warn({ service: name }, `health-monitor: ${name} disappeared`)
            } catch (err: any) {
                logger.error({ err: err?.message, service: name }, 'health-monitor: failed to insert disappearance event')
            }
            lastKnownState.set(name, 'down')
        }
    }
}

// ── Disk Usage Polling ─────────────────────────────────────────────────────

async function pollDisk(): Promise<void> {
    let dfOutput: string
    try {
        dfOutput = exec('df -h / | tail -1')
    } catch (err: any) {
        logger.error({ err: err?.message }, 'health-monitor: df failed')
        return
    }

    const match = dfOutput.match(/(\d+)%/)
    if (!match) return

    const percent = parseInt(match[1], 10)
    const rawMatch = dfOutput.match(/(\S+\s+\S+\s+\S+\s+\S+)/)
    const valueRaw = rawMatch ? rawMatch[1].replace(/\s+/g, ' ').trim() : `${percent}%`

    const changed = lastDiskPercent === null || Math.abs(percent - lastDiskPercent) >= DISK_CHANGE_THRESHOLD
    const thresholdExceeded = DISK_ALERT_THRESHOLDS.some(t => percent >= t)

    if (!changed && !thresholdExceeded) return

    // Only record threshold events when actually crossing a threshold boundary
    const shouldRecord = changed || (thresholdExceeded && (
        lastDiskPercent === null ||
        DISK_ALERT_THRESHOLDS.some(t => percent >= t && (lastDiskPercent ?? 0) < t)
    ))

    if (!shouldRecord) return

    try {
        await db.insert(resourceMetrics).values({
            id: ulid(),
            metricType: 'disk_usage',
            valuePercent: percent,
            valueRaw,
            thresholdExceeded,
            recordedAt: new Date(),
        })

        if (thresholdExceeded) {
            logger.warn({ percent, valueRaw }, `health-monitor: disk usage ${percent}% — threshold exceeded`)
        }
    } catch (err: any) {
        logger.error({ err: err?.message }, 'health-monitor: failed to insert disk metric')
    }

    lastDiskPercent = percent
}

// ── Main Loop ──────────────────────────────────────────────────────────────

async function poll(): Promise<void> {
    await Promise.all([pollContainers(), pollDisk()])
}

// ── Seed last known state from DB ──────────────────────────────────────────

async function seedState(): Promise<void> {
    try {
        // Get the most recent event per service
        const rows = await db.execute(sql`
            SELECT DISTINCT ON (service_name) service_name, status
            FROM service_health_events
            ORDER BY service_name, recorded_at DESC
        `)

        for (const row of rows as any[]) {
            lastKnownState.set(row.service_name, row.status)
        }

        logger.info({ services: lastKnownState.size }, 'health-monitor: seeded state from DB')
    } catch {
        // Table may not exist yet — fine, start fresh
    }

    // Seed disk
    try {
        const rows = await db.execute(sql`
            SELECT value_percent FROM resource_metrics
            WHERE metric_type = 'disk_usage'
            ORDER BY recorded_at DESC LIMIT 1
        `)
        const row = (rows as any[])[0]
        if (row) lastDiskPercent = row.value_percent
    } catch { /* fine */ }
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function initHealthTables(): Promise<void> {
    try {
        await db.execute(sql`
            DO $$ BEGIN
                CREATE TYPE service_health_status AS ENUM ('healthy', 'unhealthy', 'down', 'starting');
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$
        `)

        await db.execute(sql`
            CREATE TABLE IF NOT EXISTS service_health_events (
                id TEXT PRIMARY KEY,
                service_name TEXT NOT NULL,
                status service_health_status NOT NULL,
                previous_status TEXT,
                error_message TEXT,
                metadata JSONB,
                recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `)
        await db.execute(sql`CREATE INDEX IF NOT EXISTS service_health_events_service_idx ON service_health_events (service_name)`)
        await db.execute(sql`CREATE INDEX IF NOT EXISTS service_health_events_recorded_idx ON service_health_events (recorded_at)`)
        await db.execute(sql`CREATE INDEX IF NOT EXISTS service_health_events_status_idx ON service_health_events (status)`)

        await db.execute(sql`
            CREATE TABLE IF NOT EXISTS resource_metrics (
                id TEXT PRIMARY KEY,
                metric_type TEXT NOT NULL,
                value_percent REAL NOT NULL,
                value_raw TEXT,
                threshold_exceeded BOOLEAN NOT NULL DEFAULT FALSE,
                recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `)
        await db.execute(sql`CREATE INDEX IF NOT EXISTS resource_metrics_type_idx ON resource_metrics (metric_type)`)
        await db.execute(sql`CREATE INDEX IF NOT EXISTS resource_metrics_recorded_idx ON resource_metrics (recorded_at)`)

        logger.info('Health tables initialized')
    } catch (err) {
        logger.warn({ err }, 'Health tables init failed (may already exist)')
    }
}

export async function startInfraHealthMonitor(): Promise<void> {
    if (process.env.DOCKER_SOCKET_ENABLED !== 'true') {
        logger.info('Infra health monitor disabled (requires DOCKER_SOCKET_ENABLED=true)')
        return
    }

    await initHealthTables()
    await seedState()

    logger.info({ interval: POLL_INTERVAL }, 'Starting infra health monitor')

    // First poll after 5s (let other init finish)
    setTimeout(async () => {
        await poll()
        _timer = setInterval(poll, POLL_INTERVAL)
    }, 5_000)
}

export function stopInfraHealthMonitor(): void {
    if (_timer) {
        clearInterval(_timer)
        _timer = null
    }
}

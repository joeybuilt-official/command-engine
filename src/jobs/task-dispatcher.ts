// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Task Dispatcher — runs every 30 seconds
 *
 * Picks the oldest queued task (single concurrency), executes via
 * the configured TaskExecutor backend, and records results.
 */
import { db, sql, eq, tasks, issueFlags } from '../db/index.js'
import { getExecutor } from '../executors/index.js'
import { logger } from '../logger.js'

const DISPATCH_INTERVAL = 30 * 1000 // 30 seconds
let _timer: ReturnType<typeof setInterval> | null = null
let _dispatching = false

async function dispatch(): Promise<void> {
    if (_dispatching) return
    _dispatching = true

    try {
        // Single concurrency — skip if anything already running
        const [running] = await db.select({ id: tasks.id })
            .from(tasks)
            .where(eq(tasks.status, 'running'))
            .limit(1)

        if (running) {
            logger.debug({ runningTaskId: running.id }, 'task-dispatcher: task already running, skip')
            return
        }

        // Pick oldest queued task (highest priority first, then oldest)
        const [candidate] = await db.select()
            .from(tasks)
            .where(eq(tasks.status, 'queued'))
            .orderBy(sql`priority DESC, created_at ASC`)
            .limit(1)

        if (!candidate) return

        const taskId = candidate.id
        const ctx = candidate.context as Record<string, unknown> | null
        const description = (ctx?.description as string) ?? (ctx?.message as string) ?? ''

        if (!description) {
            logger.warn({ taskId }, 'task-dispatcher: task has no description, marking blocked')
            await db.update(tasks)
                .set({ status: 'blocked', executorMeta: { error: 'no description in context' } as unknown as Record<string, unknown> })
                .where(eq(tasks.id, taskId))
            return
        }

        // Claim
        await db.update(tasks)
            .set({ status: 'claimed', claimedAt: new Date() })
            .where(eq(tasks.id, taskId))

        logger.info({ taskId, type: candidate.type }, 'task-dispatcher: claimed task')

        // Update to running
        await db.update(tasks)
            .set({ status: 'running' })
            .where(eq(tasks.id, taskId))

        // Execute
        const executor = getExecutor()
        const result = await executor.execute({
            taskId,
            prompt: description,
            cwd: (ctx?.cwd as string) ?? undefined,
            allowedTools: (ctx?.allowedTools as string[]) ?? undefined,
            timeout: (ctx?.timeout as number) ?? undefined,
        })

        if (result.success) {
            await db.update(tasks)
                .set({
                    status: 'complete',
                    completedAt: new Date(),
                    outcomeSummary: result.output.slice(0, 2000),
                    tokensIn: result.tokensIn ?? null,
                    tokensOut: result.tokensOut ?? null,
                    costUsd: result.costUsd ?? null,
                    executorBackend: executor.name,
                    executorMeta: { durationMs: result.durationMs, output: result.output.slice(0, 10000) } as unknown as Record<string, unknown>,
                })
                .where(eq(tasks.id, taskId))

            logger.info({ taskId, durationMs: result.durationMs }, 'task-dispatcher: task complete')

            // Auto-resolve linked flag if task succeeded
            const flagId = (candidate as Record<string, unknown>).flagId as string | null
            if (flagId) {
                await db.update(issueFlags)
                    .set({ status: 'auto_resolved', resolvedBy: 'task-dispatcher', resolvedAt: new Date() })
                    .where(eq(issueFlags.id, flagId))
                logger.info({ taskId, flagId }, 'task-dispatcher: auto-resolved linked flag')
            }
        } else {
            const attemptCount = (candidate.attemptCount ?? 0) + 1
            await db.update(tasks)
                .set({
                    status: 'blocked',
                    attemptCount,
                    executorBackend: executor.name,
                    executorMeta: { error: result.error, durationMs: result.durationMs } as unknown as Record<string, unknown>,
                })
                .where(eq(tasks.id, taskId))

            logger.warn({ taskId, error: result.error, attemptCount }, 'task-dispatcher: task failed, blocked')
        }
    } catch (err) {
        logger.error({ err }, 'task-dispatcher: dispatch loop error')
    } finally {
        _dispatching = false
    }
}

export async function initTaskColumns(): Promise<void> {
    try {
        await db.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS flag_id TEXT`)
        await db.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS executor_backend TEXT`)
        await db.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS executor_meta JSONB`)
        logger.info('Task executor columns initialized')
    } catch (err) {
        logger.warn({ err }, 'Task executor columns init failed (may already exist)')
    }
}

export async function startTaskDispatcher(): Promise<void> {
    logger.info({ interval: DISPATCH_INTERVAL }, 'Starting task dispatcher')

    await initTaskColumns()

    // First dispatch after 15s (let tables init)
    setTimeout(async () => {
        await dispatch()
        _timer = setInterval(dispatch, DISPATCH_INTERVAL)
    }, 15_000)
}

export function stopTaskDispatcher(): void {
    if (_timer) {
        clearInterval(_timer)
        _timer = null
    }
}

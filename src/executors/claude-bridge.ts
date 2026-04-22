// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import type { TaskExecutor, ExecutorRequest, ExecutorResult } from './types.js'
import { logger } from '../logger.js'

const BRIDGE_URL = process.env.CLAUDE_BRIDGE_URL ?? 'http://host.docker.internal:9100'
const BRIDGE_AUTH_KEY = process.env.CLAUDE_BRIDGE_AUTH_KEY ?? 'joeybuilt-claude-bridge-2026'

export class ClaudeBridgeExecutor implements TaskExecutor {
    name = 'claude-bridge'

    async execute(req: ExecutorRequest): Promise<ExecutorResult> {
        const start = Date.now()

        try {
            const res = await fetch(`${BRIDGE_URL}/run`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${BRIDGE_AUTH_KEY}`,
                },
                body: JSON.stringify({
                    prompt: req.prompt,
                    cwd: req.cwd,
                    allowedTools: req.allowedTools,
                    timeout: req.timeout,
                }),
                signal: AbortSignal.timeout(req.timeout ?? 300_000),
            })

            const durationMs = Date.now() - start

            if (!res.ok) {
                const text = await res.text().catch(() => 'no body')
                logger.error({ status: res.status, body: text, taskId: req.taskId }, 'claude-bridge: non-ok response')
                return { success: false, output: '', durationMs, error: `bridge returned ${res.status}: ${text}` }
            }

            const body = await res.json() as { ok: boolean; output?: string; error?: string }

            if (!body.ok) {
                return { success: false, output: body.output ?? '', durationMs, error: body.error ?? 'bridge returned ok:false' }
            }

            return {
                success: true,
                output: body.output ?? '',
                durationMs,
            }
        } catch (err) {
            const durationMs = Date.now() - start
            const msg = err instanceof Error ? err.message : String(err)
            logger.error({ err, taskId: req.taskId }, 'claude-bridge: execute failed')
            return { success: false, output: '', durationMs, error: msg }
        }
    }

    async healthCheck(): Promise<boolean> {
        try {
            const res = await fetch(`${BRIDGE_URL}/health`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${BRIDGE_AUTH_KEY}` },
                signal: AbortSignal.timeout(5_000),
            })
            return res.ok
        } catch {
            return false
        }
    }
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import type { TaskExecutor } from './types.js'
import { ClaudeBridgeExecutor } from './claude-bridge.js'

export type { TaskExecutor, ExecutorRequest, ExecutorResult } from './types.js'

let _instance: TaskExecutor | null = null

export function getExecutor(): TaskExecutor {
    if (_instance) return _instance

    const backend = process.env.EXECUTOR_BACKEND ?? 'claude-bridge'

    switch (backend) {
        case 'claude-bridge':
            _instance = new ClaudeBridgeExecutor()
            break
        default:
            throw new Error(`Unknown executor backend: ${backend}`)
    }

    return _instance
}

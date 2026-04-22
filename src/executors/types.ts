// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

export interface ExecutorRequest {
    taskId: string
    prompt: string
    cwd?: string
    allowedTools?: string[]
    timeout?: number
}

export interface ExecutorResult {
    success: boolean
    output: string
    tokensIn?: number
    tokensOut?: number
    costUsd?: number
    durationMs: number
    error?: string
}

export interface TaskExecutor {
    name: string
    execute(req: ExecutorRequest): Promise<ExecutorResult>
    healthCheck(): Promise<boolean>
}

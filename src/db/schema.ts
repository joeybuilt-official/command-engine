import {
    pgTable,
    uuid,
    text,
    timestamp,
    boolean,
    integer,
    real,
    jsonb,
    pgEnum,
    index,
    uniqueIndex,
} from 'drizzle-orm/pg-core'

// ── Enums ────────────────────────────────────────────────────────

export const authTypeEnum = pgEnum('auth_type', [
    'oauth2',
    'api_key',
    'webhook',
    'none',
])

export const connectionStatusEnum = pgEnum('connection_status', [
    'active',
    'error',
    'expired',
    'disconnected',
])

export const cronRunStatusEnum = pgEnum('cron_run_status', [
    'success',
    'failure',
])

export const memberRoleEnum = pgEnum('member_role', ['owner', 'admin', 'member', 'viewer'])

export const taskTypeEnum = pgEnum('task_type', [
    'coding',
    'deployment',
    'research',
    'ops',
    'opportunity',
    'monitoring',
    'report',
    'online',
    'automation',
    'writing',
    'general',
    'data',
    'marketing',
])

export const taskStatusEnum = pgEnum('task_status', [
    'queued',
    'claimed',
    'running',
    'complete',
    'blocked',
    'cancelled',
])

export const taskSourceEnum = pgEnum('task_source', [
    'telegram',
    'slack',
    'discord',
    'scanner',
    'github',
    'cron',
    'dashboard',
    'api',
    'extension',
    'sentry',
])

// ── Tables ───────────────────────────────────────────────────────

export const workspaces = pgTable('workspaces', {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    ownerId: uuid('owner_id').notNull(),
    settings: jsonb('settings').default('{}').notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
})

export const workspaceMembers = pgTable('workspace_members', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    role: memberRoleEnum('role').default('member').notNull(),
    invitedByUserId: uuid('invited_by_user_id'),
    joinedAt: timestamp('joined_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => [
    uniqueIndex('workspace_members_workspace_user_idx').on(table.workspaceId, table.userId),
    index('workspace_members_workspace_idx').on(table.workspaceId),
    index('workspace_members_user_idx').on(table.userId),
])

export const tasks = pgTable('tasks', {
    id: text('id').primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: taskTypeEnum('type').notNull(),
    status: taskStatusEnum('status').default('queued').notNull(),
    priority: integer('priority').default(1).notNull(),
    source: taskSourceEnum('source').notNull(),
    project: text('project'),
    context: jsonb('context').notNull(),
    qualityScore: real('quality_score'),
    confidenceScore: real('confidence_score'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    costUsd: real('cost_usd'),
    costCeilingUsd: real('cost_ceiling_usd'),
    tokenBudget: integer('token_budget'),
    promptVersion: text('prompt_version'),
    outcomeSummary: text('outcome_summary'),
    attemptCount: integer('attempt_count').default(0).notNull(),
    deliverable: jsonb('deliverable'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    claimedAt: timestamp('claimed_at', { mode: 'date' }),
    completedAt: timestamp('completed_at', { mode: 'date' }),
}, (table) => [
    index('tasks_workspace_status_idx').on(table.workspaceId, table.status),
    index('tasks_workspace_project_idx').on(table.workspaceId, table.project),
])

export const cronJobs = pgTable('cron_jobs', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    schedule: text('schedule').notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    taskType: text('task_type').notNull().default('general'),
    taskContext: jsonb('task_context').notNull().default('{}'),
    nextRunAt: timestamp('next_run_at', { mode: 'date' }),
    lastRunAt: timestamp('last_run_at', { mode: 'date' }),
    lastRunStatus: cronRunStatusEnum('last_run_status'),
    consecutiveFailures: integer('consecutive_failures').default(0).notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
})

export const connectionsRegistry = pgTable('connections_registry', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    category: text('category').notNull(),
    logoUrl: text('logo_url'),
    authType: authTypeEnum('auth_type').notNull(),
    oauthScopes: jsonb('oauth_scopes').default('[]').notNull(),
    setupFields: jsonb('setup_fields').default('[]').notNull(),
    toolsProvided: jsonb('tools_provided').default('[]').notNull(),
    cardsProvided: jsonb('cards_provided').default('[]').notNull(),
    isCore: boolean('is_core').default(false).notNull(),
    isGenerated: boolean('is_generated').default(false).notNull(),
    docUrl: text('doc_url'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
})

export const installedConnections = pgTable('installed_connections', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    registryId: text('registry_id')
        .notNull()
        .references(() => connectionsRegistry.id),
    name: text('name').notNull(),
    credentials: jsonb('credentials').notNull(),
    enabledTools: jsonb('enabled_tools').$type<string[] | null>().default(null),
    scopesGranted: jsonb('scopes_granted').default('[]').notNull(),
    status: connectionStatusEnum('status').default('active').notNull(),
    lastVerifiedAt: timestamp('last_verified_at', { mode: 'date' }),
    errorDetail: text('error_detail'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => [
    uniqueIndex('installed_connections_workspace_registry_uq').on(table.workspaceId, table.registryId),
    index('installed_connections_workspace_idx').on(table.workspaceId),
])

// ── Deploy History ──────────────────────────────────────────────

export const deployStatusEnum = pgEnum('deploy_status', [
    'pending',
    'building',
    'deploying',
    'healthy',
    'failed',
    'rolled_back',
])

export const deploys = pgTable('deploys', {
    id: uuid('id').defaultRandom().primaryKey(),
    app: text('app').notNull(),
    commitSha: text('commit_sha').notNull(),
    commitMessage: text('commit_message'),
    branch: text('branch').default('main').notNull(),
    status: deployStatusEnum('status').default('pending').notNull(),
    triggeredBy: text('triggered_by').default('webhook').notNull(),
    imageTag: text('image_tag'),
    previousImageTag: text('previous_image_tag'),
    durationMs: integer('duration_ms'),
    error: text('error'),
    healthCheckUrl: text('health_check_url'),
    startedAt: timestamp('started_at', { mode: 'date' }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { mode: 'date' }),
}, (table) => [
    index('deploys_app_idx').on(table.app),
    index('deploys_started_idx').on(table.startedAt),
])

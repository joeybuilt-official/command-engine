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

export const issueFlagSeverityEnum = pgEnum('issue_flag_severity', [
    'critical',
    'warning',
    'info',
])

export const issueFlagCategoryEnum = pgEnum('issue_flag_category', [
    'delivery_failure',
    'service_outage',
    'error_spike',
    'empty_response',
    'duplicate_response',
    'timeout',
    'disk_alert',
    'webhook_failure',
])

export const issueFlagStatusEnum = pgEnum('issue_flag_status', [
    'open',
    'acknowledged',
    'resolved',
    'auto_resolved',
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
    flagId: text('flag_id'),
    executorBackend: text('executor_backend'),
    executorMeta: jsonb('executor_meta'),
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

// ── Analytics & Errors ───────────────────────────────────────────────────

export const analyticsEvents = pgTable('analytics_events', {
    id: uuid('id').defaultRandom().primaryKey(),
    instanceId: text('instance_id').notNull(),
    app: text('app').notNull().default('plexo'),
    eventName: text('event_name').notNull(),
    properties: jsonb('properties').default('{}').notNull(),
    plexoVersion: text('plexo_version'),
    nodeVersion: text('node_version'),
    receivedAt: timestamp('received_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    index('analytics_events_instance_received_idx').on(table.instanceId, table.receivedAt),
    index('analytics_events_name_idx').on(table.eventName),
    index('analytics_events_received_idx').on(table.receivedAt),
])

export const errorReportStatusEnum = pgEnum('error_report_status', [
    'unresolved',
    'resolved',
    'ignored',
])

export const errorReports = pgTable('error_reports', {
    id: uuid('id').defaultRandom().primaryKey(),
    instanceId: text('instance_id').notNull(),
    app: text('app').notNull().default('plexo'),
    fingerprint: text('fingerprint').notNull(),
    message: text('message').notNull(),
    stackTrace: text('stack_trace'),
    context: jsonb('context').default('{}').notNull(),
    deployId: text('deploy_id'),
    status: errorReportStatusEnum('status').default('unresolved').notNull(),
    assignedTo: text('assigned_to'),
    resolvedAt: timestamp('resolved_at', { mode: 'date', withTimezone: true }),
    firstSeenAt: timestamp('first_seen_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
    occurrenceCount: integer('occurrence_count').default(1).notNull(),
}, (table) => [
    uniqueIndex('error_reports_instance_fingerprint_idx').on(table.instanceId, table.fingerprint),
    index('error_reports_status_idx').on(table.status),
    index('error_reports_last_seen_idx').on(table.lastSeenAt),
])

export const featureFlags = pgTable('feature_flags', {
    id: uuid('id').defaultRandom().primaryKey(),
    key: text('key').notNull().unique(),
    name: text('name'),
    description: text('description'),
    active: boolean('active').default(false).notNull(),
    rolloutPercentage: integer('rollout_percentage').default(100).notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
})

// ── Infrastructure Health ──────────────────────────────────────

export const serviceHealthStatusEnum = pgEnum('service_health_status', [
    'healthy',
    'unhealthy',
    'down',
    'starting',
])

export const serviceHealthEvents = pgTable('service_health_events', {
    id: text('id').primaryKey(),
    serviceName: text('service_name').notNull(),
    status: serviceHealthStatusEnum('status').notNull(),
    previousStatus: text('previous_status'),
    errorMessage: text('error_message'),
    metadata: jsonb('metadata'),
    recordedAt: timestamp('recorded_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    index('service_health_events_service_idx').on(table.serviceName),
    index('service_health_events_recorded_idx').on(table.recordedAt),
    index('service_health_events_status_idx').on(table.status),
])

export const resourceMetrics = pgTable('resource_metrics', {
    id: text('id').primaryKey(),
    metricType: text('metric_type').notNull(),
    valuePercent: real('value_percent').notNull(),
    valueRaw: text('value_raw'),
    thresholdExceeded: boolean('threshold_exceeded').default(false).notNull(),
    recordedAt: timestamp('recorded_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    index('resource_metrics_type_idx').on(table.metricType),
    index('resource_metrics_recorded_idx').on(table.recordedAt),
])

// ── Webhook Deliveries ─────────────────────────────────────────

export const webhookDeliveryStatusEnum = pgEnum('webhook_delivery_status', [
    'received',
    'processed',
    'failed',
    'skipped',
])

export const webhookDeliveries = pgTable('webhook_deliveries', {
    id: text('id').primaryKey(),
    source: text('source').notNull(),
    eventType: text('event_type').notNull(),
    payloadSummary: text('payload_summary'),
    status: webhookDeliveryStatusEnum('status').default('received').notNull(),
    errorMessage: text('error_message'),
    processingTimeMs: integer('processing_time_ms'),
    receivedAt: timestamp('received_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    index('webhook_deliveries_source_idx').on(table.source),
    index('webhook_deliveries_status_idx').on(table.status),
    index('webhook_deliveries_received_idx').on(table.receivedAt),
])

// ── Deploy History ──────────────────────────────────────────────

export const deployStatusEnum = pgEnum('deploy_status', [
    'pending',
    'building',
    'deploying',
    'healthy',
    'failed',
    'smoke_failed',
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

// ── Issue Flags ──────────────────────────────────────────────────

export const issueFlags = pgTable('issue_flags', {
    id: text('id').primaryKey(),
    severity: issueFlagSeverityEnum('severity').notNull(),
    category: issueFlagCategoryEnum('category').notNull(),
    title: text('title').notNull(),
    detail: text('detail').notNull(),
    sourceService: text('source_service').notNull(),
    sourceId: text('source_id'),
    status: issueFlagStatusEnum('status').default('open').notNull(),
    resolvedBy: text('resolved_by'),
    resolvedAt: timestamp('resolved_at', { mode: 'date', withTimezone: true }),
    metadata: jsonb('metadata'),
    taskId: text('task_id'),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    index('issue_flags_severity_idx').on(table.severity),
    index('issue_flags_category_idx').on(table.category),
    index('issue_flags_status_idx').on(table.status),
    index('issue_flags_created_idx').on(table.createdAt),
    index('issue_flags_source_service_idx').on(table.sourceService),
])

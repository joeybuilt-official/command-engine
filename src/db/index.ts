import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.js'

export type Database = ReturnType<typeof drizzle<typeof schema>>

let _db: Database | null = null

/** Lazy DB accessor — throws at first use if DATABASE_URL is missing, not at import time */
export const db: Database = new Proxy({} as Database, {
    get(_target, prop) {
        if (!_db) {
            const url = process.env.DATABASE_URL
            if (!url) throw new Error('DATABASE_URL environment variable is required')
            _db = drizzle(postgres(url), { schema })
        }
        return ((_db as unknown) as Record<string | symbol, unknown>)[prop]
    },
})

export {
    workspaces,
    workspaceMembers,
    tasks,
    cronJobs,
    connectionsRegistry,
    installedConnections,
    deploys,
    webhookDeliveries,
    analyticsEvents,
    errorReports,
    featureFlags,
    serviceHealthEvents,
    resourceMetrics,
    issueFlags,
} from './schema.js'

export { sql, eq, and, or, ne, desc, asc, inArray, isNull, isNotNull, ilike, lt, lte, gte, count, gt } from 'drizzle-orm'

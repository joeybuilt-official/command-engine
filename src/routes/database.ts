import { Router, type Router as RouterType } from 'express'
import { execSync } from 'node:child_process'
import { logger } from '../logger.js'

export const databaseRouter: RouterType = Router()

const DB_NAME = process.env.INTROSPECT_DB ?? 'pushd'
const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/
const DANGEROUS_KEYWORDS = /\b(DROP|DELETE|INSERT|UPDATE|ALTER|CREATE|TRUNCATE)\b/i

function validateIdentifier(value: string, label: string): string | null {
    if (!IDENTIFIER_RE.test(value)) return `Invalid ${label}: ${value}`
    return null
}

function psql(query: string): string {
    const escaped = query.replace(/'/g, "'\\''")
    const pgContainer = process.env.POSTGRES_CONTAINER ?? 'postgres'
    return execSync(`docker exec ${pgContainer} psql -U postgres -d ${DB_NAME} -t -A -F '\t' -c '${escaped}'`, {
        encoding: 'utf8', timeout: 15_000,
    }).trim()
}

// GET /database/schemas
databaseRouter.get('/schemas', async (_req, res) => {
    try {
        const raw = psql("SELECT schemaname, COUNT(*)::int FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') GROUP BY schemaname ORDER BY schemaname")
        const schemas = raw.split('\n').filter(Boolean).map(line => {
            const [name, tables] = line.split('\t')
            return { name, tables: parseInt(tables ?? '0') }
        })
        res.json({ schemas })
    } catch (err: any) {
        logger.error({ err: err?.message }, 'DB schemas query failed')
        res.status(500).json({ error: err?.message ?? 'Failed' })
    }
})

// GET /database/tables?schema=auth
databaseRouter.get('/tables', async (req, res) => {
    const schema = (req.query.schema as string) ?? 'public'
    const err = validateIdentifier(schema, 'schema')
    if (err) { res.status(400).json({ error: err }); return }
    try {
        const raw = psql(`SELECT tablename, (SELECT COUNT(*)::int FROM information_schema.columns c WHERE c.table_schema = '${schema}' AND c.table_name = t.tablename) FROM pg_tables t WHERE schemaname = '${schema}' ORDER BY tablename`)
        const tables = raw.split('\n').filter(Boolean).map(line => {
            const [name, columns] = line.split('\t')
            return { name, columns: parseInt(columns ?? '0') }
        })
        res.json({ schema, tables })
    } catch (err: any) {
        res.status(500).json({ error: err?.message ?? 'Failed' })
    }
})

// GET /database/table?schema=auth&table=user
databaseRouter.get('/table', async (req, res) => {
    const schema = (req.query.schema as string) ?? 'public'
    const table = req.query.table as string
    if (!table) { res.status(400).json({ error: 'table parameter required' }); return }
    const schemaErr = validateIdentifier(schema, 'schema')
    if (schemaErr) { res.status(400).json({ error: schemaErr }); return }
    const tableErr = validateIdentifier(table, 'table')
    if (tableErr) { res.status(400).json({ error: tableErr }); return }
    try {
        const colRaw = psql(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = '${table}' ORDER BY ordinal_position`)
        const columns = colRaw.split('\n').filter(Boolean).map(line => {
            const [name, type, nullable, default_value] = line.split('\t')
            return { name, type, nullable, default_value: default_value || null }
        })
        const countRaw = psql(`SELECT COUNT(*)::int FROM "${schema}"."${table}"`)
        res.json({ schema, table, columns, rowCount: parseInt(countRaw) || 0 })
    } catch (err: any) {
        res.status(500).json({ error: err?.message ?? 'Failed' })
    }
})

// POST /database/query — SELECT only
databaseRouter.post('/query', async (req, res) => {
    const { query } = req.body as { query?: string }
    if (!query?.trim()) { res.status(400).json({ error: 'query required' }); return }
    const sanitized = query.trim().replace(/;/g, '')
    const normalized = sanitized.toUpperCase().replace(/\s+/g, ' ')
    // Must truly start with SELECT/WITH/EXPLAIN (not buried after a comment or other statement)
    if (!/^(SELECT|WITH|EXPLAIN)\s/i.test(sanitized.trim())) {
        res.status(403).json({ error: 'Only SELECT, WITH, and EXPLAIN queries are allowed' })
        return
    }
    if (DANGEROUS_KEYWORDS.test(normalized)) {
        res.status(403).json({ error: 'Query contains forbidden keywords' })
        return
    }
    try {
        const raw = psql(sanitized)
        const lines = raw.split('\n').filter(Boolean)
        const rows = lines.map(line => {
            const cols = line.split('\t')
            const obj: Record<string, string> = {}
            cols.forEach((v, i) => { obj[`col_${i}`] = v })
            return obj
        })
        res.json({ rows: rows.slice(0, 500), totalRows: rows.length, truncated: rows.length > 500 })
    } catch (err: any) {
        res.status(400).json({ error: err?.message ?? 'Query failed' })
    }
})

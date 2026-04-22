import express from 'express'
import cors from 'cors'
import { logger } from './logger.js'
import { cmdCenterAuth } from './middleware/auth.js'
import { ingestAuth } from './middleware/ingest-auth.js'
import { cmdCenterRouter } from './routes/index.js'
import { ingestRouter, initAnalyticsTables } from './routes/analytics.js'
import { startHealthMonitor } from './health-monitor.js'
import { startInfraHealthMonitor } from './jobs/health-monitor.js'
import { deploymentsRouter, initDeploysTable, initWebhookDeliveriesTable } from './routes/deployments.js'
import { flagsIngestRouter, initIssueFlagsTable } from './routes/flags.js'
import { startFlagScanner } from './jobs/flag-scanner.js'
import { startDataCleanup } from './jobs/data-cleanup.js'
import { startTaskDispatcher } from './jobs/task-dispatcher.js'
import { telegramWebhookRouter, initTelegramWebhook } from './routes/telegram.js'

const app = express()
const PORT = parseInt(process.env.PORT ?? '3001', 10)

// CORS
const corsOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
    : ['http://localhost:3000']

app.use(cors({
    origin: corsOrigins,
    credentials: true,
}))

// Body parsing
app.use(express.json({ limit: '1mb' }))

// Health endpoint (unauthenticated)
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'command-engine', timestamp: new Date().toISOString() })
})

// GitHub webhook — unauthenticated (HMAC signature only, GitHub can't send Bearer tokens)
app.use('/api/v1/cmd-center/deployments/webhook', deploymentsRouter)

// Analytics/error ingest — lightweight auth (instance UUID + optional service key)
app.use('/api/v1/cmd-center/ingest', ingestAuth, ingestRouter)

// Flag ingest from Plexo — same lightweight auth
app.use('/api/v1/cmd-center/flags/ingest', ingestAuth, flagsIngestRouter)

// Telegram webhook — unauthenticated (Telegram can't send Bearer tokens)
app.use('/api/v1/cmd-center/telegram', telegramWebhookRouter)

// Mount cmd-center routes with auth
app.use('/api/v1/cmd-center', cmdCenterAuth, cmdCenterRouter)

// Global error handler — must be after all routes
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err, method: req.method, url: req.url }, 'Unhandled error')
    res.status(500).json({ error: 'Internal server error' })
})

// Start server
const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, 'command-engine started')
})

// Initialize tables
initDeploysTable().catch(err => {
    logger.error({ err }, 'Failed to init deploys table')
})
initWebhookDeliveriesTable().catch(err => {
    logger.error({ err }, 'Failed to init webhook deliveries table')
})
initAnalyticsTables().catch(err => {
    logger.error({ err }, 'Failed to init analytics tables')
})
initIssueFlagsTable().catch(err => {
    logger.error({ err }, 'Failed to init issue flags table')
})

// Start health monitors
startHealthMonitor().catch(err => {
    logger.error({ err }, 'Failed to start health monitor')
})
startInfraHealthMonitor().catch(err => {
    logger.error({ err }, 'Failed to start infra health monitor')
})
startFlagScanner().catch(err => {
    logger.error({ err }, 'Failed to start flag scanner')
})
startDataCleanup().catch(err => {
    logger.error({ err }, 'Failed to start data cleanup job')
})
startTaskDispatcher().catch(err => {
    logger.error({ err }, 'Failed to start task dispatcher')
})
initTelegramWebhook().catch(err => {
    logger.warn({ err }, 'Telegram webhook init failed (non-fatal)')
})

// Graceful shutdown
function shutdown(signal: string) {
    logger.info({ signal }, 'Shutting down')
    server.close(() => {
        logger.info('Server closed')
        process.exit(0)
    })
    // Force exit after 10s
    setTimeout(() => {
        logger.warn('Forced shutdown after timeout')
        process.exit(1)
    }, 10_000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled promise rejection')
})
process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception — shutting down')
    process.exit(1)
})

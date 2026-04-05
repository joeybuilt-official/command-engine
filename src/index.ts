import express from 'express'
import cors from 'cors'
import { logger } from './logger.js'
import { cmdCenterAuth } from './middleware/auth.js'
import { cmdCenterRouter } from './routes/index.js'
import { startHealthMonitor } from './health-monitor.js'

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

// Mount cmd-center routes with auth
app.use('/api/v1/cmd-center', cmdCenterAuth, cmdCenterRouter)

// Start server
const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, 'command-engine started')
})

// Start health monitor if enabled
startHealthMonitor().catch(err => {
    logger.error({ err }, 'Failed to start health monitor')
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

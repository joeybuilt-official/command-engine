import pino from 'pino'

export const logger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: 'command-engine' },
    ...(process.env.NODE_ENV === 'production'
        ? {}
        : { transport: { target: 'pino-pretty' } }
    ),
    redact: {
        paths: [
            'req.headers.authorization',
            '*.token',
            '*.password',
            '*.secret',
            '*.apiKey',
            '*.accessToken',
            '*.refreshToken',
        ],
    },
})

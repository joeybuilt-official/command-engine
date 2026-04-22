import { Router, type Router as RouterType, type Request, type Response } from 'express'
import { db, tasks } from '../db/index.js'
import { logger } from '../logger.js'
import { ulid } from 'ulid'

// ── Config ──────────────────────────────────────────────────────

const BOT_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN ?? ''
const WEBHOOK_SECRET = () => process.env.TELEGRAM_WEBHOOK_SECRET ?? ''
const AUTHORIZED_CHAT_IDS = (): Set<number> => {
    const raw = process.env.AUTHORIZED_CHAT_IDS ?? '55917049'
    return new Set(raw.split(',').map(Number))
}
const WORKSPACE_ID = () => process.env.CMD_CENTER_WORKSPACE_ID ?? ''
const TELEGRAM_API = () => `https://api.telegram.org/bot${BOT_TOKEN()}`
const MAX_MSG_LEN = 4096

// ── Dedup ───────────────────────────────────────────────────────

const seenUpdates = new Set<number>()
const DEDUP_CAP = 1000

function isDuplicate(updateId: number): boolean {
    if (seenUpdates.has(updateId)) return true
    seenUpdates.add(updateId)
    if (seenUpdates.size > DEDUP_CAP) {
        const first = seenUpdates.values().next().value!
        seenUpdates.delete(first)
    }
    return false
}

// ── Telegram helpers ────────────────────────────────────────────

function splitMessage(text: string): string[] {
    if (text.length <= MAX_MSG_LEN) return [text]
    const chunks: string[] = []
    let remaining = text
    while (remaining.length > 0) {
        if (remaining.length <= MAX_MSG_LEN) {
            chunks.push(remaining)
            break
        }
        // Try splitting at last newline within limit
        let splitIdx = remaining.lastIndexOf('\n', MAX_MSG_LEN)
        if (splitIdx <= 0) splitIdx = MAX_MSG_LEN
        chunks.push(remaining.slice(0, splitIdx))
        remaining = remaining.slice(splitIdx)
    }
    return chunks
}

export async function sendTelegramMessage(chatId: number | string, text: string): Promise<void> {
    const chunks = splitMessage(text)
    for (const chunk of chunks) {
        const resp = await fetch(`${TELEGRAM_API()}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'Markdown' }),
        })
        if (!resp.ok) {
            const body = await resp.text()
            logger.error({ chatId, status: resp.status, body }, 'telegram: sendMessage failed')
        }
    }
}

// ── Webhook init ────────────────────────────────────────────────

export async function initTelegramWebhook(): Promise<void> {
    const token = BOT_TOKEN()
    if (!token) {
        logger.warn('telegram: TELEGRAM_BOT_TOKEN not set, skipping webhook init')
        return
    }
    const secret = WEBHOOK_SECRET()
    const url = 'https://command.joeybuilt.com/api/v1/cmd-center/telegram/webhook'
    try {
        const resp = await fetch(`${TELEGRAM_API()}/setWebhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, secret_token: secret, allowed_updates: ['message'] }),
        })
        const data = await resp.json() as Record<string, unknown>
        if (data.ok) {
            logger.info('telegram: webhook registered')
        } else {
            logger.error({ data }, 'telegram: setWebhook failed')
        }
    } catch (err) {
        logger.error({ err }, 'telegram: setWebhook request error')
    }
}

// ── Router ──────────────────────────────────────────────────────

export const telegramWebhookRouter: RouterType = Router()

telegramWebhookRouter.post('/webhook', async (req: Request, res: Response) => {
    // Verify secret header
    const headerSecret = req.headers['x-telegram-bot-api-secret-token']
    const expected = WEBHOOK_SECRET()
    if (expected && headerSecret !== expected) {
        res.status(403).json({ error: 'Forbidden' })
        return
    }

    const update = req.body
    if (!update?.update_id) {
        res.sendStatus(200)
        return
    }

    // Dedup
    if (isDuplicate(update.update_id)) {
        res.sendStatus(200)
        return
    }

    const message = update.message
    if (!message?.text) {
        res.sendStatus(200)
        return
    }

    const chatId: number = message.chat.id
    const authorized = AUTHORIZED_CHAT_IDS()
    if (!authorized.has(chatId)) {
        logger.warn({ chatId }, 'telegram: unauthorized chat')
        res.sendStatus(200)
        return
    }

    const messageText: string = message.text
    const messageId: number = message.message_id
    const from = message.from
        ? { id: message.from.id, username: message.from.username, firstName: message.from.first_name }
        : undefined

    try {
        await db.insert(tasks).values({
            id: ulid(),
            type: 'automation',
            source: 'telegram',
            status: 'queued',
            workspaceId: WORKSPACE_ID(),
            context: { description: messageText, chatId, messageId, from } as Record<string, unknown>,
        })

        // Fire-and-forget reply
        sendTelegramMessage(chatId, 'On it.').catch(err =>
            logger.error({ err }, 'telegram: reply failed'),
        )

        res.sendStatus(200)
    } catch (err) {
        logger.error({ err }, 'telegram: task creation failed')
        res.sendStatus(200) // Always 200 to Telegram so it doesn't retry
    }
})

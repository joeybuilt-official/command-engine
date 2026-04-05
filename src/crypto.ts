import { createHmac, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'

function deriveKey(workspaceId: string): Buffer {
    const rootKey = process.env.ENCRYPTION_SECRET
    if (!rootKey) throw new Error('ENCRYPTION_SECRET not set — cannot encrypt credentials')
    return createHmac('sha256', rootKey).update(workspaceId).digest()
}

function b64url(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function fromB64url(s: string): Buffer {
    const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (s.length % 4)) % 4)
    return Buffer.from(padded, 'base64')
}

export function encrypt(plaintext: string, workspaceId: string): string {
    const key = deriveKey(workspaceId)
    const iv = randomBytes(12)
    const cipher = createCipheriv(ALGORITHM, key, iv)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const authTag = cipher.getAuthTag()
    return `${b64url(iv)}.${b64url(ciphertext)}.${b64url(authTag)}`
}

export function decrypt(token: string, workspaceId: string): string {
    const parts = token.split('.')
    if (parts.length !== 3) throw new Error('Invalid encrypted token format')
    const [ivStr, ciphertextStr, authTagStr] = parts
    const key = deriveKey(workspaceId)
    const iv = fromB64url(ivStr!)
    const ciphertext = fromB64url(ciphertextStr!)
    const authTag = fromB64url(authTagStr!)
    const decipher = createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(authTag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

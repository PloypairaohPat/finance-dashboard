import crypto from 'crypto'

const ALGORITHM = 'aes-256-gcm'

function loadEncryptionKey(raw: string | undefined): Buffer {
  if (!raw) {
    throw new Error(
      'ENCRYPTION_KEY is not set. Expected a 64-character hex string (32 bytes) for AES-256-GCM.'
    )
  }

  if (!/^[0-9a-fA-F]+$/.test(raw)) {
    throw new Error(
      'ENCRYPTION_KEY is invalid: it must contain only hexadecimal characters (0-9, a-f). ' +
      'Expected 64 hex characters (32 bytes) for AES-256-GCM.'
    )
  }

  if (raw.length !== 64) {
    throw new Error(
      `ENCRYPTION_KEY is invalid: expected exactly 64 hex characters (32 bytes) for ` +
      `AES-256-GCM, but got ${raw.length} characters.`
    )
  }

  return Buffer.from(raw, 'hex')
}

const KEY = loadEncryptionKey(process.env.ENCRYPTION_KEY)

export function encrypt(text: string): string {
  const iv         = crypto.randomBytes(12)
  const cipher     = crypto.createCipheriv(ALGORITHM, KEY, iv)
  const encrypted  = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const tag        = cipher.getAuthTag()
  return [iv.toString('hex'), tag.toString('hex'), encrypted.toString('hex')].join(':')
}

export function decrypt(payload: string): string {
  const [ivHex, tagHex, encHex] = payload.split(':')
  const iv       = Buffer.from(ivHex,  'hex')
  const tag      = Buffer.from(tagHex, 'hex')
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv)
  decipher.setAuthTag(tag)
  return decipher.update(Buffer.from(encHex, 'hex')).toString('utf8')
       + decipher.final('utf8')
}
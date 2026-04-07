import crypto from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const KEY       = Buffer.from(process.env.ENCRYPTION_KEY!,  'hex')

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
// ─────────────────────────────────────────────────────────────────
//  auditKey — the key the audit log hashes people, Items and sessions with.
//
//  AUDIT_HASH_KEY: 32 random bytes as 64 hex characters, set in Railway on
//  its own. Never derived from ENCRYPTION_KEY, and refused if it equals it.
//  Validated at startup like ENCRYPTION_KEY (app.ts calls auditHashKey()):
//  hex checked before decoding, exact length, the value never echoed.
//
//  Rows hold HMAC-SHA256(key, "<kind>:<id>"): pseudonymous while we hold the
//  key, since anyone with it and an id can find that id's rows. The kind
//  keeps a user id and an Item id that happened to be equal from matching.
// ─────────────────────────────────────────────────────────────────

import crypto from 'crypto'

/** Bump with a new key; rows record the version they were hashed with. */
export const AUDIT_KEY_VERSION = 1

export function loadAuditHashKey(raw: string | undefined, encryptionKey: string | undefined = process.env.ENCRYPTION_KEY): Buffer {
  if (!raw) {
    throw new Error('AUDIT_HASH_KEY is not set. Expected a 64-character hex string (32 bytes).')
  }
  if (!/^[0-9a-fA-F]+$/.test(raw)) {
    throw new Error(
      'AUDIT_HASH_KEY is invalid: it must contain only hexadecimal characters (0-9, a-f). ' +
      'Expected 64 hex characters (32 bytes).',
    )
  }
  if (raw.length !== 64) {
    throw new Error(`AUDIT_HASH_KEY is invalid: expected exactly 64 hex characters (32 bytes), but got ${raw.length} characters.`)
  }
  if (encryptionKey && raw.toLowerCase() === encryptionKey.toLowerCase()) {
    throw new Error('AUDIT_HASH_KEY is invalid: it must be its own random value, not ENCRYPTION_KEY.')
  }
  return Buffer.from(raw, 'hex')
}

let key: Buffer | undefined

/** The validated key, loaded once. Throws (without the value) if it's missing or malformed. */
export function auditHashKey(): Buffer {
  return (key ??= loadAuditHashKey(process.env.AUDIT_HASH_KEY))
}

export type AuditHashKind = 'user' | 'item' | 'session'

/** 64 lowercase hex: what the subject, itemRef and sessionRef columns hold. */
export function auditHash(kind: AuditHashKind, id: string): string {
  return crypto.createHmac('sha256', auditHashKey()).update(`${kind}:${id}`).digest('hex')
}

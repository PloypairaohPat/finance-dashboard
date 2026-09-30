// ─────────────────────────────────────────────────────────────────
//  tests/redact.test.ts — nothing token-shaped reaches a terminal
//
//  The scripts that decrypt Plaid access tokens (audit-plaid-webhooks,
//  update-item-webhook) print through redact(). A Plaid SDK error can quote the
//  request it failed on, which carries the token, so this is the last line
//  between a failed call and a token in someone's scrollback or paste.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest'
import { redact } from '../scripts/lib/read-only-db'

// Shaped like the real thing; not a real token.
const ACCESS = 'access-production-9f8e7d6c-5b4a-3210-fedc-ba9876543210'

describe('redact', () => {
  it('removes a production access token, including inside an SDK error', () => {
    const err = `Error: Request failed {"access_token":"${ACCESS}","webhook":"https://x/webhook"}`
    const out = redact(err)
    expect(out).not.toContain(ACCESS)
    expect(out).not.toMatch(/9f8e7d6c/)
    expect(out).toContain('access-<redacted>')
    expect(out).toContain('https://x/webhook') // the rest survives
  })

  it('covers sandbox and development tokens, and public and link tokens', () => {
    for (const t of [
      'access-sandbox-11111111-2222-3333-4444-555555555555',
      'access-development-11111111-2222-3333-4444-555555555555',
      'public-production-11111111-2222-3333-4444-555555555555',
      'link-sandbox-11111111-2222-3333-4444-555555555555',
    ]) {
      expect(redact(`x ${t} y`), t).not.toMatch(/11111111/)
    }
  })

  it('removes a 64-hex-character key such as ENCRYPTION_KEY', () => {
    expect(redact(`key=${'ab'.repeat(32)}`)).toBe('key=<redacted-64-hex>')
  })

  it('leaves an item_id and a request_id readable', () => {
    const line = 'item eVBnVMp7zdTJLkRNr33Rs6zr7KNJqBFL1DzZ9 request_id xY7aB2'
    expect(redact(line)).toBe(line)
  })
})

// ─────────────────────────────────────────────────────────────────
//  tests/webhook-url.test.ts — the startup check on WEBHOOK_URL
//
//  WEBHOOK_URL stayed on a dead Railway domain from April to September 2026
//  while the backend moved twice, and every Plaid Item linked in that time was
//  created pointing at it. The check exists to make that a log line on the
//  first boot after a domain change. The first case below is that incident.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest'
import { checkWebhookUrl } from '../src/lib/webhookUrl'

const LIVE = 'finance-dashboard-production-b725.up.railway.app'
const DEAD = 'finance-dashboard-production-1a0c.up.railway.app'

describe('checkWebhookUrl', () => {
  it('warns on the incident: WEBHOOK_URL left on the old domain', () => {
    const r = checkWebhookUrl(`https://${DEAD}/webhook`, LIVE)
    expect(r.level).toBe('warn')
    expect(r.message).toContain(DEAD)
    expect(r.message).toContain(LIVE)
    expect(r.message).toMatch(/update-item-webhook/)
  })

  it('is ok when WEBHOOK_URL points at this deployment', () => {
    expect(checkWebhookUrl(`https://${LIVE}/webhook`, LIVE).level).toBe('ok')
  })

  it('compares hosts case-insensitively, and tolerates a scheme or path on the domain', () => {
    expect(checkWebhookUrl(`https://${LIVE.toUpperCase()}/webhook`, LIVE).level).toBe('ok')
    expect(checkWebhookUrl(`https://${LIVE}/webhook`, `https://${LIVE}/`).level).toBe('ok')
  })

  it('is an error when WEBHOOK_URL is missing or not a URL', () => {
    expect(checkWebhookUrl(undefined, LIVE).level).toBe('error')
    expect(checkWebhookUrl('', LIVE).level).toBe('error')
    expect(checkWebhookUrl('not a url', LIVE).level).toBe('error')
  })

  it('flags a wrong path or plain http even when the host matches', () => {
    const noPath = checkWebhookUrl(`https://${LIVE}/`, LIVE)
    expect(noPath.level).toBe('warn')
    expect(noPath.message).toMatch(/route is POST \/webhook/)
    expect(checkWebhookUrl(`http://${LIVE}/webhook`, LIVE).message).toMatch(/https/)
  })

  it('cannot check without RAILWAY_PUBLIC_DOMAIN (local, CI) and says so rather than passing silently', () => {
    const r = checkWebhookUrl('http://localhost:3001/webhook', undefined)
    expect(r.level).toBe('ok')
    expect(r.message).toMatch(/cannot be checked/)
  })
})

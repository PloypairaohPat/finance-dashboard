// ─────────────────────────────────────────────────────────────────
//  webhookUrl.ts — is WEBHOOK_URL pointing at THIS deployment?
//
//  Plaid stores the webhook URL on each Item at the moment the Item is created
//  (link/token/create reads WEBHOOK_URL — plaid.service.ts). Changing the env
//  var afterwards does nothing to existing Items. So a stale WEBHOOK_URL is
//  silent: new Items are born pointing at a dead domain, and nobody finds out
//  until someone reads Plaid's webhook logs.
//
//  That happened. The backend's Railway domain changed twice in April 2026
//  (1a0c → 5227 → b725, when the service's certificate was regenerated), the
//  frontend's API_URL was updated both times, and WEBHOOK_URL — set by hand in
//  the Railway dashboard, and in no file in this repo — was not. Four Items
//  created as late as September were baked with the dead 1a0c domain.
//
//  This check turns that into a log line on the first boot after a domain
//  change. It compares WEBHOOK_URL's host with RAILWAY_PUBLIC_DOMAIN, which
//  Railway injects as a bare hostname ("example.up.railway.app").
//
//  It LOGS rather than refusing to boot, deliberately. Railway documents
//  RAILWAY_PUBLIC_DOMAIN as "the public service or customer domain" without
//  saying which one it holds once a custom domain is added, so a mismatch may
//  be legitimate then. A loud line is right; taking the API down is not.
// ─────────────────────────────────────────────────────────────────

export type WebhookCheckLevel = 'ok' | 'warn' | 'error'

export interface WebhookCheck {
  level: WebhookCheckLevel
  message: string
}

/** Pure, so it can be tested without an environment. */
export function checkWebhookUrl(
  webhookUrl: string | undefined,
  railwayPublicDomain: string | undefined,
): WebhookCheck {
  if (!webhookUrl) {
    return { level: 'error', message: 'WEBHOOK_URL is not set: new Plaid Items would be created with no webhook.' }
  }

  let parsed: URL
  try {
    parsed = new URL(webhookUrl)
  } catch {
    return { level: 'error', message: `WEBHOOK_URL is not a valid URL: "${webhookUrl}".` }
  }

  const host = parsed.hostname.toLowerCase()
  const problems: string[] = []
  if (parsed.protocol !== 'https:' && host !== 'localhost') {
    problems.push(`uses ${parsed.protocol.replace(':', '')}, and Plaid delivers webhooks over https`)
  }
  if (!parsed.pathname.replace(/\/+$/, '').endsWith('/webhook')) {
    problems.push(`path is "${parsed.pathname}", but the route is POST /webhook`)
  }

  if (!railwayPublicDomain) {
    // Local development, CI and tests: there is no deployment to compare against.
    const base = `WEBHOOK_URL host ${host}. RAILWAY_PUBLIC_DOMAIN is not set, so it cannot be checked against this deployment.`
    return problems.length
      ? { level: 'warn', message: `${base} Also: ${problems.join('; ')}.` }
      : { level: 'ok', message: base }
  }

  const expected = railwayPublicDomain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  if (host !== expected) {
    return {
      level: 'warn',
      message:
        `WEBHOOK_URL points at ${host}, but this deployment is ${expected}. ` +
        'Every Plaid Item linked from now on will be created with that webhook, and Plaid keeps it: ' +
        'if that host is not this backend, those Items will 404 on every webhook until each one is ' +
        'updated with /item/webhook/update (scripts/update-item-webhook.ts). ' +
        'Fix WEBHOOK_URL in the Railway dashboard. (If a custom domain is in use and points here, ' +
        'this mismatch is expected.)' +
        (problems.length ? ` Also: ${problems.join('; ')}.` : ''),
    }
  }

  return problems.length
    ? { level: 'warn', message: `WEBHOOK_URL matches this deployment (${host}), but: ${problems.join('; ')}.` }
    : { level: 'ok', message: `WEBHOOK_URL matches this deployment (${host}).` }
}

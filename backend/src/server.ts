// ─────────────────────────────────────────────────────────────────
//  server.ts  —  Plaid Integration Backend (process entry point)
// ─────────────────────────────────────────────────────────────────

import { app, plaidClient } from './app'
import { startScheduler } from './scheduler'
import { checkWebhookUrl } from './lib/webhookUrl'
import { runningCommit } from './lib/runningCommit'

// ── Start ─────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3001
app.listen(PORT, () => {
  console.log(`\n🚀 Plaid backend running on http://localhost:${PORT}`)
  console.log(`   Environment: ${process.env.PLAID_ENV}`)
  console.log(`   Commit:      ${runningCommit()}`)
  console.log(`   Products:    ${process.env.PLAID_PRODUCTS}`)
  console.log(`\n   Endpoints:`)
  console.log(`   POST /create_link_token`)
  console.log(`   POST /exchange_public_token`)
  console.log(`   GET  /accounts`)
  console.log(`   GET  /transactions`)
  console.log(`   GET  /categories`)
  console.log(`   POST /webhook`)
  console.log(`   GET  /health\n`)

  // Plaid bakes this URL into every Item at creation, so a stale value is
  // silent until webhooks start 404ing. Say so on every boot.
  const webhook = checkWebhookUrl(process.env.WEBHOOK_URL, process.env.RAILWAY_PUBLIC_DOMAIN)
  const mark = { ok: '✅', warn: '⚠️ ', error: '❌' }[webhook.level]
  const log = webhook.level === 'ok' ? console.log : console.error
  log(`   ${mark} Webhook: ${webhook.message}\n`)

  startScheduler(plaidClient)
})

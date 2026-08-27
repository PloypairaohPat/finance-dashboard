// ─────────────────────────────────────────────────────────────────
//  server.ts  —  Plaid Integration Backend (process entry point)
// ─────────────────────────────────────────────────────────────────

import { app, plaidClient } from './app'
import { startScheduler } from './scheduler'

// ── Start ─────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3001
app.listen(PORT, () => {
  console.log(`\n🚀 Plaid backend running on http://localhost:${PORT}`)
  console.log(`   Environment: ${process.env.PLAID_ENV}`)
  console.log(`   Products:    ${process.env.PLAID_PRODUCTS}`)
  console.log(`\n   Endpoints:`)
  console.log(`   POST /create_link_token`)
  console.log(`   POST /exchange_public_token`)
  console.log(`   GET  /accounts`)
  console.log(`   GET  /transactions`)
  console.log(`   GET  /categories`)
  console.log(`   GET  /recurring`)
  console.log(`   POST /webhook`)
  console.log(`   GET  /health\n`)
  startScheduler(plaidClient)
})

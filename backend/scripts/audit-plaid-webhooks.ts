// ─────────────────────────────────────────────────────────────────
//  audit-plaid-webhooks — which Plaid Items point at a dead webhook URL.
//
//  READ-ONLY, both sides. The database connection refuses writes and proves it
//  (scripts/lib/read-only-db.ts). The Plaid call is /item/get, which reads.
//  Nothing here changes an Item; scripts/update-item-webhook.ts does that.
//
//  Why Items can be stuck: WEBHOOK_URL is read at link-token creation only
//  (plaid.service.ts, both the normal and the update-mode call). Plaid stores
//  it ON the Item, so an Item keeps whatever the URL was on the day it was
//  created. Changing the env var afterwards does nothing to existing Items,
//  and nothing in this codebase calls /item/webhook/update.
//
//  This repo's own history dates the domains:
//    until 2026-04-23 15:45 EDT   ...-1a0c.up.railway.app   (dead)
//    until 2026-04-28 14:10 EDT   ...-5227.up.railway.app   (dead)
//    since  2026-04-28 14:10 EDT  ...-b725.up.railway.app   (current)
//  The 5227 window is easy to miss: its Items 404 exactly like the 1a0c ones.
//
//  Reading an access token is what makes the Plaid half of this need Railway:
//  ENCRYPTION_KEY and PLAID_SECRET exist only there.
//
//    railway run npx tsx scripts/audit-plaid-webhooks.ts --allow-remote <db host>
//
//  --no-plaid   database only: no token is decrypted, so it can run anywhere
//               the database is reachable.
// ─────────────────────────────────────────────────────────────────

import { connectReadOnly, hasFlag, makeRefuse, redact } from './lib/read-only-db'

const CURRENT_WEBHOOK = 'https://finance-dashboard-production-b725.up.railway.app/webhook'
const DEMO_USER_IDS = new Set(['demo-user'])
// Typed explicitly: TypeScript only narrows after a never-returning call when
// the callee's type is declared, not inferred.
const refuse: (message: string) => never = makeRefuse('audit-plaid-webhooks')

/** Only the host matters for "is this the live backend?". */
const hostOf = (url: string | null | undefined): string => {
  if (!url) return '(none set)'
  try {
    return new URL(url).hostname
  } catch {
    return '(unparseable)'
  }
}
const CURRENT_HOST = hostOf(CURRENT_WEBHOOK)

async function main() {
  const db = await connectReadOnly('audit-plaid-webhooks')
  console.log(`\nReading ${db.database} on ${db.host} via ${db.envName} — read-only (${db.writeRefusedWith}).`)

  const items = await db.prisma.plaidItem.findMany({
    // accessToken is selected only when the Plaid check is on, and even then it
    // is passed straight to decrypt() and never printed or returned.
    select: {
      id: true, itemId: true, userId: true, institutionName: true,
      status: true, createdAt: true, lastSyncedAt: true,
      accessToken: !hasFlag('no-plaid'),
    },
    orderBy: { createdAt: 'asc' },
  })
  const real = items.filter((i) => !DEMO_USER_IDS.has(i.userId))

  console.log(`${items.length} Plaid item(s); ${items.length - real.length} belong to the demo user and are skipped.\n`)
  if (real.length === 0) {
    console.log('No real-user items in this database.\n')
    await db.prisma.$disconnect()
    return
  }

  let plaidClient: any = null
  if (!hasFlag('no-plaid')) {
    for (const key of ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'ENCRYPTION_KEY']) {
      if (!process.env[key]) {
        refuse(
          `${key} is not set, so the Plaid check cannot run. Use \`railway run\` (those values live only in Railway), or pass --no-plaid for the database half alone.`,
        )
      }
    }
    plaidClient = (await import('../src/lib/plaidClient')).plaidClient
  }

  const { decrypt } = await import('../src/utils/encrypt')
  const rows: Array<Record<string, string>> = []
  let stale = 0

  for (const item of real) {
    const row: Record<string, string> = {
      item_id: item.itemId,
      user: `${item.userId.slice(0, 12)}…`,
      institution: item.institutionName ?? '(unknown)',
      created: item.createdAt.toISOString().slice(0, 10),
      our_status: item.status,
      webhook_host: '(not checked)',
      verdict: '',
    }

    if (plaidClient) {
      try {
        // /item/get reads. The response carries no token; only the fields
        // named below are ever read out of it.
        const res = await plaidClient.itemGet({ access_token: decrypt(item.accessToken!) })
        const webhook: string | null = res.data.item?.webhook ?? null
        row.webhook_host = hostOf(webhook)
        const matches = row.webhook_host === CURRENT_HOST
        if (!matches) stale += 1
        row.verdict = matches ? 'OK' : webhook ? 'STALE — points at a dead domain' : 'NO WEBHOOK SET'
      } catch (e: any) {
        const code = e?.response?.data?.error_code ?? e?.code ?? 'unknown'
        row.webhook_host = '(call failed)'
        row.verdict = `Plaid error: ${redact(String(code))}`
      }
    }
    rows.push(row)
  }

  const cols = Object.keys(rows[0])
  const width = (c: string) => Math.max(c.length, ...rows.map((r) => r[c].length))
  const widths = Object.fromEntries(cols.map((c) => [c, width(c)]))
  const line = (get: (c: string) => string) => cols.map((c) => get(c).padEnd(widths[c])).join('  ')
  console.log(line((c) => c))
  console.log(cols.map((c) => '─'.repeat(widths[c])).join('  '))
  for (const r of rows) console.log(redact(line((c) => r[c])))

  console.log(`\nCurrent webhook host: ${CURRENT_HOST}`)
  if (hasFlag('no-plaid')) {
    console.log('Plaid not checked (--no-plaid): the table shows what our database knows, not what Plaid stores.')
    console.log('An item created before 2026-04-28 14:10 EDT is a candidate; only /item/get settles it.')
  } else {
    console.log(
      stale === 0
        ? 'Every item points at the current webhook. Nothing to fix.'
        : `${stale} item(s) need scripts/update-item-webhook.ts.`,
    )
  }
  console.log()
  await db.prisma.$disconnect()
}

main().catch((e) => {
  // Redacted: a Plaid SDK error can quote the request, which contains the token.
  console.error(redact(String(e?.stack ?? e)))
  process.exit(1)
})

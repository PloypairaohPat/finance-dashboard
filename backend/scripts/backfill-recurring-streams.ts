// ─────────────────────────────────────────────────────────────────
//  backfill-recurring-streams — fill RecurringStream for every existing
//  non-demo Item, once (M7.6 PR 2a). Their transaction history finished long
//  ago, so nothing will trigger a first refresh for them.
//
//  It uses the refresh's own two parts (src/services/recurringStreams.service):
//  fetch every Item first, then apply them all in ONE transaction — so there
//  is one definition of a refresh, and no Plaid call ever happens inside the
//  transaction.
//
//    dry run (database read-only; still calls Plaid once per Item):
//      railway run npx tsx scripts/backfill-recurring-streams.ts --allow-remote <db host> --dry-run
//    real run, with the dry run's figure:
//      railway run npx tsx scripts/backfill-recurring-streams.ts --allow-remote <db host> --expect <streams>
//
//  Checked inside the transaction before it commits:
//    - the streams written equal --expect;
//    - every non-demo row outside RecurringStream is unchanged (a full-row
//      fingerprint, not just ids).
//  Any difference rolls everything back.
//
//  Counts only: "user N" and "item N", numbered exactly as
//  recurring-streams-audit.ts numbers them, so the two outputs line up.
//  Railway is needed because fetching decrypts Plaid access tokens.
// ─────────────────────────────────────────────────────────────────

import { PrismaClient } from '@prisma/client'
import { connectReadOnly, flag, hasFlag, makeRefuse, redact, resolveConnection } from './lib/read-only-db'

const SCRIPT = 'backfill-recurring-streams'
const refuse: (message: string) => never = makeRefuse(SCRIPT)
const DEMO_USER_IDS = new Set(['demo-user'])
const TIMEOUT_MS = 120_000

type ItemRow = { id: string; userId: string; itemId: string; accessToken: string }

/** Users with Items, then their Items, in the audit script's order. */
async function itemsInAuditOrder(db: PrismaClient) {
  const users = await db.user.findMany({
    where: { plaidItems: { some: {} } },
    select: { id: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const real = users.filter((u) => !DEMO_USER_IDS.has(u.id))
  const out: Array<{ userLabel: string; itemLabel: string; item: ItemRow }> = []
  let itemNo = 0
  for (const [ui, u] of real.entries()) {
    const items = await db.plaidItem.findMany({
      where: { userId: u.id },
      select: { id: true, userId: true, itemId: true, accessToken: true },
      orderBy: { createdAt: 'asc' },
    })
    for (const item of items) out.push({ userLabel: `user ${ui + 1}`, itemLabel: `item ${++itemNo}`, item })
  }
  return out
}

async function main() {
  const dryRun = hasFlag('dry-run')
  const rawExpect = flag('expect')
  if (!dryRun && (rawExpect === undefined || !/^\d+$/.test(rawExpect))) {
    refuse('the real run needs --expect <streams>, the "streams to write" figure from a dry run.')
  }

  // Database: read-only for the dry run, a client on the resolved URL for the real one.
  let db: PrismaClient
  let where: string
  if (dryRun) {
    const ro = await connectReadOnly(SCRIPT)
    db = ro.prisma
    where = `${ro.database} at ${ro.host} via ${ro.envName}, read-only (${ro.writeRefusedWith})`
  } else {
    const conn = resolveConnection(SCRIPT)
    db = new PrismaClient({ datasourceUrl: conn.url.toString() })
    where = `${conn.url.pathname.replace(/^\//, '')} on ${conn.host} via ${conn.envName}`
  }
  console.log(`\n${SCRIPT} — ${dryRun ? 'DRY RUN' : 'WRITING'} on ${where}. Counts only.\n`)

  // Loaded now: they read credentials from the environment.
  const { plaidClient } = await import('../src/lib/plaidClient')
  const { runRecurringBackfill } = await import('./lib/recurring-backfill')
  const svc = await import('../src/services/recurringStreams.service')

  try {
    // ── 1. fetch every Item, before any write ─────────────────────
    const targets = await itemsInAuditOrder(db)
    const fetched: Array<{ userLabel: string; itemLabel: string; f: Awaited<ReturnType<typeof svc.fetchItemStreams>> }> = []
    const errors = new Map<string, number>()
    for (const t of targets) {
      try {
        fetched.push({ userLabel: t.userLabel, itemLabel: t.itemLabel, f: await svc.fetchItemStreams(plaidClient, t.item) })
      } catch (e) {
        if (!(e instanceof svc.StreamFetchError)) throw e
        errors.set(e.errorCode, (errors.get(e.errorCode) ?? 0) + 1)
        console.log(`  ${t.userLabel} / ${t.itemLabel}: Plaid error ${e.errorCode} — left as it is`)
      }
    }

    // ── 2. the plan, per Item ─────────────────────────────────────
    console.log('user / item     | returned in | returned out | not our account | to write | to remove')
    let toWrite = 0, toRemove = 0, dropped = 0
    for (const { userLabel, itemLabel, f } of fetched) {
      const plan = await svc.planItemStreams(db, f)
      const inflow = f.streams.filter((s) => s.direction === 'inflow').length
      const outflow = f.streams.length - inflow
      toWrite += plan.upserts.length
      toRemove += plan.removeStreamIds.length
      dropped += plan.droppedForAccounts
      console.log([`${userLabel} / ${itemLabel}`.padEnd(15), String(inflow).padEnd(11), String(outflow).padEnd(12),
        String(plan.droppedForAccounts).padEnd(15), String(plan.upserts.length).padEnd(8), plan.removeStreamIds.length].join(' | '))
    }
    console.log(`\n  Items fetched: ${fetched.length} of ${targets.length}; Plaid errors: ${errors.size === 0 ? 'none' : [...errors].map(([c, n]) => `${c} ${n}`).join(', ')}`)
    console.log(`  streams to write: ${toWrite}; to remove: ${toRemove}; left out (account we don't hold): ${dropped}`)

    if (dryRun) {
      console.log(`\n  To write: the same command with --expect ${toWrite} instead of --dry-run.\n`)
      return
    }

    // ── 3. apply all, in one transaction, checked before commit ───
    const result = await runRecurringBackfill(db, fetched.map((x) => x.f), Number(rawExpect), { timeoutMs: TIMEOUT_MS })
    console.log(`\n  committed: ${result.written} stream(s) written.`)
    console.log('  Checked inside the transaction: the count matched --expect, and every non-demo row')
    console.log('  outside RecurringStream is unchanged.\n')
  } catch (e: any) {
    console.error(`\n✗ ${SCRIPT}: ${dryRun ? 'stopped' : 'rolled back. Nothing was written.'}`)
    console.error(`  ${redact(String(e?.message ?? e)).split('\n').join('\n  ')}\n`)
    process.exitCode = 1
  } finally {
    await db.$disconnect()
  }
}

main().catch((e) => {
  console.error(redact(String(e?.stack ?? e)))
  process.exit(1)
})

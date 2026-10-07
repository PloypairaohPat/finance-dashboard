// ─────────────────────────────────────────────────────────────────
//  stale-confirmations-audit — confirmations whose charge has changed since
//  the user confirmed it (M7.6's open follow-up; docs/m7.6-audit.md).
//
//  READ-ONLY, and stores nothing. On the read-only connection
//  (scripts/lib/read-only-db.ts): confirmations, the charges they sit on, our
//  classifier's verdict on those charges today, and the Subscriptions tab as
//  composeSubscriptions builds it. No Plaid calls, no decryption.
//
//  Per user, and for the demo user on its own line:
//    - confirmations, and how many sit on a charge that is (a) live but not
//      spending today, (b) soft-deleted, (c) pending;
//    - (b) split: removed charges that are still in one of the user's streams,
//      whose confirmation that stream can no longer see;
//    - items the tab shows (Subscriptions and Bills) that include any charge
//      that isn't live, posted spending, how many of those are walked series,
//      and how many count toward the totals.
//
//  Counts only. Users appear as "user N"; no names, amounts, ids or dates.
//
//    railway run npx tsx scripts/stale-confirmations-audit.ts --allow-remote <db host>
// ─────────────────────────────────────────────────────────────────

import { connectReadOnly, redact } from './lib/read-only-db'

const DAY = 86_400_000

async function main() {
  const db = await connectReadOnly('stale-confirmations-audit')
  console.log(`\nReading ${db.database} on ${db.host} via ${db.envName} — read-only (${db.writeRefusedWith}).`)
  console.log('Stored data only; no Plaid calls. Counts only.\n')

  // Loaded after connectReadOnly so they use the connection it set up.
  const { DEMO_USER_ID } = await import('../src/middleware/auth')
  const { classifyWindow } = await import('../src/services/classification.service')
  const { getPeriodStartDay } = await import('../src/services/user.service')
  const { composeSubscriptions } = await import('../src/services/streamComposition.service')

  const real = await db.prisma.user.findMany({
    where: { id: { not: DEMO_USER_ID }, plaidItems: { some: {} } },
    select: { id: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const demo = await db.prisma.user.findUnique({ where: { id: DEMO_USER_ID }, select: { id: true } })
  const who: Array<[string, string]> = real.map((u, i) => [`user ${i + 1}`, u.id])
  if (demo) who.push(['demo', demo.id])
  console.log(`${real.length} non-demo user(s) with Items${demo ? ', and the demo user' : ''}.\n`)

  /** Our verdict today on each of these live rows, by id. */
  async function verdicts(userId: string, rows: Array<{ id: string; date: Date }>): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    if (rows.length === 0) return out
    const times = rows.map((r) => r.date.getTime())
    const { rows: classified } = await classifyWindow(userId, {
      since: new Date(Math.min(...times)), until: new Date(Math.max(...times) + DAY), startDay: await getPeriodStartDay(userId),
    })
    for (const c of classified) out.set(c.id, c.verdict.kind)
    return out
  }

  for (const [label, userId] of who) {
    const marks = await db.prisma.subscriptionMark.findMany({
      where: { userId, kind: 'confirmed' },
      select: { transaction: { select: { id: true, date: true, pending: true, deletedAt: true, plaidTransactionId: true } } },
    })
    const anchors = marks.map((m) => m.transaction)
    const live = anchors.filter((a) => !a.deletedAt)
    const verdictOf = await verdicts(userId, live)
    const notSpending = live.filter((a) => verdictOf.get(a.id) !== 'spend').length
    const removed = anchors.filter((a) => a.deletedAt)
    const pending = anchors.filter((a) => a.pending && !a.deletedAt).length

    // Removed anchors still named by one of the user's streams: that stream reads
    // verdicts from its live charges only, so it no longer sees this confirmation.
    const streamIds = new Set(
      (await db.prisma.recurringStream.findMany({ where: { userId }, select: { plaidTransactionIds: true } }))
        .flatMap((s) => s.plaidTransactionIds),
    )
    const removedInStream = removed.filter((a) => streamIds.has(a.plaidTransactionId)).length

    // What the tab shows: items including any charge that isn't live, posted spending.
    const tab = await composeSubscriptions(userId)
    const shown = [...tab.subscriptions, ...tab.bills]
    const shownIds = [...new Set(shown.flatMap((s) => s.txIds))]
    const shownRows = await db.prisma.transaction.findMany({
      where: { userId, id: { in: shownIds } },
      select: { id: true, date: true, pending: true, deletedAt: true },
    })
    const rowOf = new Map(shownRows.map((r) => [r.id, r]))
    const shownVerdict = await verdicts(userId, shownRows.filter((r) => !r.deletedAt))
    const sound = (id: string) => {
      const r = rowOf.get(id)
      return !!r && !r.deletedAt && !r.pending && shownVerdict.get(id) === 'spend'
    }
    // Pending charges are expected in a series (the latest charge, waiting to post);
    // counted separately from charges that are gone or aren't spending.
    const gone = (id: string) => { const r = rowOf.get(id); return !r || !!r.deletedAt || shownVerdict.get(id) !== 'spend' }
    const withGone = shown.filter((s) => s.txIds.some(gone))
    const withPending = shown.filter((s) => s.txIds.some((id) => !gone(id) && !sound(id)))
    const counted = (xs: typeof shown) => xs.filter((s) => s.status === 'active' && s.frequency !== 'UNKNOWN').length

    console.log(label)
    console.log(`  confirmations: ${anchors.length} | on a charge (a) not spending today ${notSpending}` +
      ` | (b) removed ${removed.length} (of which still in a stream ${removedInStream}) | (c) pending ${pending}`)
    console.log(`  tab items including a removed or non-spending charge: ${withGone.length}` +
      ` (walked series ${withGone.filter((s) => s.source === 'custom').length}, counting toward totals ${counted(withGone)})`)
    console.log(`  tab items including a pending charge: ${withPending.length} (counting toward totals ${counted(withPending)})`)
    console.log()
  }
  await db.prisma.$disconnect()
}

main().catch((e) => {
  console.error(redact(String(e?.stack ?? e)))
  process.exit(1)
})

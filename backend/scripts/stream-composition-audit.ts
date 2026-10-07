// ─────────────────────────────────────────────────────────────────
//  stream-composition-audit — what the Subscriptions tab shows, per user,
//  as counts: each list, what counts toward totals, suggestions, dismissals,
//  confirmations shown as marked, and the no-charge-twice invariant.
//
//  It was the gate before M7.6 PR 5e, comparing the tab on Plaid's streams
//  with the old detector's. Since PR 5f deleted the detector, it reports the
//  streams side alone, in the same lines as before, so a run before a change
//  and a run after it can be compared line for line.
//
//  READ-ONLY, and stores nothing. Runs composeSubscriptions, the code the tab
//  and the bell read, on the read-only connection (scripts/lib/read-only-db.ts).
//  No Plaid calls, no decryption.
//
//  Counts only. Users appear as "user N"; no names, amounts, ids or dates.
//
//    railway run npx tsx scripts/stream-composition-audit.ts --allow-remote <db host>
// ─────────────────────────────────────────────────────────────────

import { connectReadOnly, redact } from './lib/read-only-db'

async function main() {
  const db = await connectReadOnly('stream-composition-audit')
  console.log(`\nReading ${db.database} on ${db.host} via ${db.envName} — read-only (${db.writeRefusedWith}).`)
  console.log('Stored data only; no Plaid calls. Counts only.\n')

  // Loaded after connectReadOnly so they use the connection it set up.
  const { DEMO_USER_ID } = await import('../src/middleware/auth')
  const { composeSubscriptions } = await import('../src/services/streamComposition.service')

  const users = await db.prisma.user.findMany({
    where: { id: { not: DEMO_USER_ID }, plaidItems: { some: {} } },
    select: { id: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  console.log(`${users.length} non-demo user(s) with Items.\n`)

  for (const [i, user] of users.entries()) {
    const now = new Date()
    const [streams, marks] = await Promise.all([
      composeSubscriptions(user.id, now),
      db.prisma.subscriptionMark.findMany({ where: { userId: user.id }, select: { id: true, kind: true } }),
    ])
    const counted = (xs: Array<{ status: string; frequency: string }>) => xs.filter((s) => s.status === 'active' && s.frequency !== 'UNKNOWN').length
    const ended = (xs: Array<{ status: string }>) => xs.filter((s) => s.status === 'ended').length

    console.log(`user ${i + 1}`)
    console.log(`  on streams: subscriptions ${streams.subscriptions.length} (counted ${counted(streams.subscriptions)}, ended ${ended(streams.subscriptions)})` +
      ` | bills ${streams.bills.length} (counted ${counted(streams.bills)}, ended ${ended(streams.bills)})` +
      ` | suggested ${streams.suggested.length} (new ${streams.suggested.filter((s) => s.isNew).length})` +
      ` | dismissed ${streams.dismissed.length} | upcoming ${streams.upcoming.length}`)

    // Every confirmation must show as marked.
    const confirmed = marks.filter((m) => m.kind === 'confirmed')
    const shownMarks = new Set([...streams.subscriptions, ...streams.bills].map((s) => s.mark?.id).filter(Boolean))
    console.log(`  confirmations shown as marked: ${confirmed.filter((m) => shownMarks.has(m.id)).length} of ${confirmed.length}` +
      ` (a series folded into another marked item doesn't show its own)`)

    // The invariant: no charge shown twice.
    const ids = [...streams.subscriptions, ...streams.bills, ...streams.suggested].flatMap((s) => s.txIds)
    console.log(`  charges shown twice on streams: ${ids.length - new Set(ids).size}`)
    console.log()
  }
  await db.prisma.$disconnect()
}

main().catch((e) => {
  console.error(redact(String(e?.stack ?? e)))
  process.exit(1)
})

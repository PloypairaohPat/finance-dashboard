// ─────────────────────────────────────────────────────────────────
//  stream-composition-audit — what the tab would show on streams (M7.6 PR 5)
//  set against what it shows today, per user. The gate before PR 5e.
//
//  READ-ONLY, and stores nothing. Runs the same code both sides use —
//  analyseWithDetector (today) and composeSubscriptions (5e) — on the
//  read-only connection (scripts/lib/read-only-db.ts). No Plaid calls, no
//  decryption.
//
//  Counts only. Users appear as "user N"; no names, amounts, ids or dates.
//  Monthly totals appear as a direction (higher, lower, same), never a figure.
//
//    railway run npx tsx scripts/stream-composition-audit.ts --allow-remote <db host>
// ─────────────────────────────────────────────────────────────────

import { connectReadOnly, redact } from './lib/read-only-db'

type Counter = Map<string, number>
const bump = (m: Counter, k: string) => m.set(k, (m.get(k) ?? 0) + 1)
const show = (title: string, m: Counter) => {
  const rows = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  console.log(`  ${title}: ${rows.length === 0 ? '(none)' : rows.map(([k, n]) => `${k} ${n}`).join(' | ')}`)
}
const direction = (before: number, after: number) => (after > before ? 'higher' : after < before ? 'lower' : 'same')

async function main() {
  const db = await connectReadOnly('stream-composition-audit')
  console.log(`\nReading ${db.database} on ${db.host} via ${db.envName} — read-only (${db.writeRefusedWith}).`)
  console.log('Stored data only; no Plaid calls. Counts only.\n')

  // Loaded after connectReadOnly so they use the connection it set up.
  const { DEMO_USER_ID } = await import('../src/middleware/auth')
  const { analyseWithDetector } = await import('../src/services/subscriptions.service')
  const { composeSubscriptions } = await import('../src/services/streamComposition.service')

  const users = await db.prisma.user.findMany({
    where: { id: { not: DEMO_USER_ID }, plaidItems: { some: {} } },
    select: { id: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  console.log(`${users.length} non-demo user(s) with Items.\n`)

  for (const [i, user] of users.entries()) {
    const now = new Date()
    const [today, streams, marks] = await Promise.all([
      analyseWithDetector(user.id, now),
      composeSubscriptions(user.id, now),
      db.prisma.subscriptionMark.findMany({ where: { userId: user.id }, select: { id: true, kind: true } }),
    ])
    const counted = (xs: Array<{ status: string; frequency: string }>) => xs.filter((s) => s.status === 'active' && s.frequency !== 'UNKNOWN').length
    const ended = (xs: Array<{ status: string }>) => xs.filter((s) => s.status === 'ended').length

    console.log(`user ${i + 1}`)
    console.log(`  today:      subscriptions ${today.subscriptions.length} (counted ${counted(today.subscriptions)}) | bills ${today.bills.length} (counted ${counted(today.bills)}) | upcoming ${today.upcoming.length}`)
    console.log(`  on streams: subscriptions ${streams.subscriptions.length} (counted ${counted(streams.subscriptions)}, ended ${ended(streams.subscriptions)})` +
      ` | bills ${streams.bills.length} (counted ${counted(streams.bills)}, ended ${ended(streams.bills)})` +
      ` | suggested ${streams.suggested.length} (new ${streams.suggested.filter((s) => s.isNew).length})` +
      ` | dismissed ${streams.dismissed.length} | upcoming ${streams.upcoming.length}`)
    console.log(`  monthly totals on streams: subscriptions ${direction(today.totals.monthlySubscriptions, streams.totals.monthlySubscriptions)}` +
      ` | bills ${direction(today.totals.monthlyBills, streams.totals.monthlyBills)} | all ${direction(today.totals.monthlyAll, streams.totals.monthlyAll)}`)

    // Where each item listed today goes: by a shared charge.
    const placeOf = new Map<string, string>()
    for (const [place, xs] of [['subscription', streams.subscriptions], ['bill', streams.bills], ['suggested', streams.suggested], ['dismissed', streams.dismissed]] as const) {
      for (const s of xs) for (const id of s.txIds) if (!placeOf.has(id)) placeOf.set(id, place)
    }
    const moves: Counter = new Map()
    for (const [kind, xs] of [['subscription', today.subscriptions], ['bill', today.bills]] as const) {
      for (const s of xs) {
        const place = s.txIds.map((id) => placeOf.get(id)).find(Boolean) ?? 'not shown'
        bump(moves, `${kind}${s.mark ? ' (marked)' : ''} → ${place}`)
      }
    }
    show("today's items, by where they land", moves)

    // Every confirmation today must still show as marked.
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

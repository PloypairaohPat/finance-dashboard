// ─────────────────────────────────────────────────────────────────
//  stream-sorting-audit — what the one definition (M7.6 PR 3) makes of the
//  streams we've stored, before any surface shows them.
//
//  READ-ONLY, and stores nothing. Reads RecurringStream rows and the
//  transactions they name on the read-only connection
//  (scripts/lib/read-only-db.ts), runs the same code PR 5's surfaces will
//  (sortUserStreams), and prints counts. No Plaid calls, no decryption.
//
//  Counts only. Users appear as "user N"; no names, amounts, ids, dates or
//  categories are printed, only buckets and reason codes.
//
//    railway run npx tsx scripts/stream-sorting-audit.ts --allow-remote <db host>
// ─────────────────────────────────────────────────────────────────

import { connectReadOnly, redact } from './lib/read-only-db'

type Counter = Map<string, number>
const bump = (m: Counter, k: string) => m.set(k, (m.get(k) ?? 0) + 1)
const show = (title: string, m: Counter) => {
  const rows = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  console.log(`  ${title}: ${rows.length === 0 ? '(none)' : rows.map(([k, n]) => `${k} ${n}`).join(' | ')}`)
}

async function main() {
  const db = await connectReadOnly('stream-sorting-audit')
  console.log(`\nReading ${db.database} on ${db.host} via ${db.envName} — read-only (${db.writeRefusedWith}).`)
  console.log('Stored streams only; no Plaid calls. Counts only.\n')

  // Loaded after connectReadOnly so they use the connection it set up.
  const { DEMO_USER_ID } = await import('../src/middleware/auth')
  const { sortUserStreams } = await import('../src/services/streamSorting.service')

  const users = await db.prisma.user.findMany({
    where: { id: { not: DEMO_USER_ID }, recurringStreams: { some: {} } },
    select: { id: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  console.log(`${users.length} non-demo user(s) with stored streams.\n`)

  for (const [i, user] of users.entries()) {
    const sorted = await sortUserStreams(user.id)
    const byBucket: Counter = new Map()
    const byReason: Counter = new Map()
    const counting: Counter = new Map()
    const confirmsAs: Counter = new Map()
    for (const { sort } of sorted) {
      bump(byBucket, sort.bucket)
      bump(byReason, `${sort.bucket} / ${sort.reason}`)
      if (sort.counts) bump(counting, sort.bucket)
      if (sort.confirmsAs) bump(confirmsAs, sort.confirmsAs)
    }
    console.log(`user ${i + 1}: ${sorted.length} stream(s)`)
    show('by bucket', byBucket)
    show('by bucket / reason', byReason)
    show('counting toward totals', counting)
    show('suggested, would land in once confirmed', confirmsAs)
    console.log()
  }
  await db.prisma.$disconnect()
}

main().catch((e) => {
  console.error(redact(String(e?.stack ?? e)))
  process.exit(1)
})

// ─────────────────────────────────────────────────────────────────
//  plaid-items-inventory — every Plaid Item this database knows about, to
//  set against Plaid's own count. READ-ONLY. No Plaid call, no token is
//  decrypted: it can run anywhere the database is reachable.
//
//  Prints, per Item: the first 8 characters of its Plaid item_id (the same
//  short form the webhook log lines use, so the two can be matched), its
//  owner as "user N", when it was created, whether it has an institution id,
//  its status, and how many accounts and live transactions hang off it. No
//  institution names, account names, masks or amounts.
//
//  Then the duplicate checks, as counts:
//    - Items per (user, institution): more than one is a duplicate link, or
//      two genuine logins at one bank (only account names and masks tell
//      those apart, so the check also counts matching accounts);
//    - Items with no institution id (the re-link lookup treats all of them
//      as one institution);
//    - Items created before 2026-09-08/09, when unlink and re-link started
//      calling /item/remove: anything unlinked or re-linked before then
//      is still live at Plaid, and is not in this list.
//
//    railway run npx tsx scripts/plaid-items-inventory.ts --allow-remote <db host>
// ─────────────────────────────────────────────────────────────────

import { connectReadOnly, redact } from './lib/read-only-db'

const DEMO_USER_IDS = new Set(['demo-user'])
const REMOVE_FIX = new Date('2026-09-09T00:00:00Z')

async function main() {
  const db = await connectReadOnly('plaid-items-inventory')
  console.log(`\nReading ${db.database} on ${db.host} via ${db.envName} — read-only (${db.writeRefusedWith}).`)
  console.log('No Plaid call; no token decrypted. Item ids are shown as their first 8 characters.\n')

  const items = await db.prisma.plaidItem.findMany({
    select: {
      id: true, itemId: true, userId: true, institutionId: true, status: true, createdAt: true,
      accounts: { select: { id: true, name: true, mask: true, _count: { select: { transactions: { where: { deletedAt: null } } } } } },
      _count: { select: { recurringStreams: true } },
    },
    orderBy: [{ createdAt: 'asc' }],
  })
  const real = items.filter((i) => !DEMO_USER_IDS.has(i.userId))
  console.log(`${items.length} Item(s) in the database; ${items.length - real.length} belong to the demo user (no Plaid Item behind them).`)
  console.log(`Real Items: ${real.length}. Plaid's count includes Items this database has lost track of; the difference is the orphans.\n`)

  const userNo = new Map<string, number>()
  for (const i of real) if (!userNo.has(i.userId)) userNo.set(i.userId, userNo.size + 1)

  console.log('item_id…  | user   | created    | institution id | status         | accounts | live transactions | recurring streams')
  for (const i of real) {
    const tx = i.accounts.reduce((s, a) => s + a._count.transactions, 0)
    console.log([
      `${i.itemId.slice(0, 8)}…`,
      `user ${userNo.get(i.userId)}`.padEnd(6),
      i.createdAt.toISOString().slice(0, 10),
      (i.institutionId ? 'yes' : 'NONE').padEnd(14),
      i.status.padEnd(14),
      String(i.accounts.length).padEnd(8),
      String(tx).padEnd(17),
      String(i._count.recurringStreams),
    ].join(' | '))
  }

  // ── duplicates ────────────────────────────────────────────────
  const byUserInst = new Map<string, typeof real>()
  for (const i of real) {
    const k = `${i.userId}|${i.institutionId ?? '(none)'}`
    byUserInst.set(k, [...(byUserInst.get(k) ?? []), i])
  }
  const multi = [...byUserInst.values()].filter((g) => g.length > 1)
  console.log(`\nUsers with more than one Item at the same institution: ${multi.length}`)
  for (const g of multi) {
    // Accounts that appear on two Items of one institution (same name and mask): a duplicate link.
    const seen = new Map<string, number>()
    for (const i of g) for (const a of i.accounts) {
      const k = `${a.name}|${a.mask ?? ''}`
      seen.set(k, (seen.get(k) ?? 0) + 1)
    }
    const repeated = [...seen.values()].filter((n) => n > 1).length
    console.log(`  user ${userNo.get(g[0].userId)}: ${g.length} Items, ${repeated} account(s) on more than one of them` +
      (repeated > 0 ? '  ← duplicate link: accounts and transactions counted twice' : '  (different accounts: two logins?)'))
  }
  console.log(`Items with no institution id: ${real.filter((i) => !i.institutionId).length}`)
  console.log(`Items created before the /item/remove fix (${REMOVE_FIX.toISOString().slice(0, 10)}): ` +
    `${real.filter((i) => i.createdAt < REMOVE_FIX).length} — still here, so not orphaned by it.`)
  console.log('\nOrphans can\'t be listed from here: the database dropped them. See the report for where to find their ids.\n')

  await db.prisma.$disconnect()
}

main().catch((e) => {
  console.error(redact(String(e?.stack ?? e)))
  process.exit(1)
})

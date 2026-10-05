// ─────────────────────────────────────────────────────────────────
//  user-data-inventory — where each user's data lives, before building
//  "delete my data". READ-ONLY. Counts only: users appear as "user N", and
//  no id, name or amount is printed.
//
//  Per table, per user: rows, including soft-deleted ones (Transaction,
//  Alert and Goal keep deleted rows, and deletion must remove those too).
//  Then orphans: rows in Budget, BalanceSnapshot, Alert, Goal and
//  RecurringStream whose userId has no User row. All five have a foreign key to
//  User now (user_foreign_keys, recurring_streams), so these should read 0; a
//  non-zero count means a key is missing or was bypassed.
//
//    railway run npx tsx scripts/user-data-inventory.ts --allow-remote <db host>
// ─────────────────────────────────────────────────────────────────

import { connectReadOnly, redact } from './lib/read-only-db'
import { NON_DEMO_TABLES } from './lib/non-demo-baseline'

const SOFT_DELETING = new Set(['Transaction', 'Alert', 'Goal'])
const ORPHAN_CHECKED = ['Budget', 'BalanceSnapshot', 'Alert', 'Goal', 'RecurringStream']

async function main() {
  const db = await connectReadOnly('user-data-inventory')
  console.log(`\nReading ${db.database} on ${db.host} via ${db.envName} — read-only (${db.writeRefusedWith}).`)
  console.log('Counts only. The demo user is listed by name; everyone else as "user N".\n')

  const users = await db.prisma.user.findMany({ select: { id: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const label = new Map(users.map((u, i) => [u.id, u.id === 'demo-user' ? 'demo-user' : `user ${i + 1}`]))

  for (const [table, owner] of NON_DEMO_TABLES) {
    if (table === 'User') continue
    const rows = await db.prisma.$queryRawUnsafe<Array<{ owner: string; n: number; deleted: number }>>(
      `SELECT "${owner}" AS owner, count(*)::int AS n,
              ${SOFT_DELETING.has(table) ? `count(*) FILTER (WHERE "deletedAt" IS NOT NULL)::int` : '0'} AS deleted
       FROM "${table}" GROUP BY "${owner}"`,
    )
    const cells = rows
      .sort((a, b) => (label.get(a.owner) ?? 'zz').localeCompare(label.get(b.owner) ?? 'zz'))
      .map((r) => `${label.get(r.owner) ?? 'NO USER ROW'}: ${r.n}${r.deleted ? ` (${r.deleted} soft-deleted)` : ''}`)
    console.log(`${table.padEnd(16)} ${cells.join(' | ') || '(empty)'}`)
  }

  console.log('\nOrphans (no User row for their userId):')
  for (const table of ORPHAN_CHECKED) {
    const [r] = await db.prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "${table}" t WHERE NOT EXISTS (SELECT 1 FROM "User" u WHERE u.id = t."userId")`,
    )
    console.log(`  ${table.padEnd(16)} ${r.n}`)
  }
  console.log()
  await db.prisma.$disconnect()
}

main().catch((e) => {
  console.error(redact(String(e?.stack ?? e)))
  process.exit(1)
})

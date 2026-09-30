// ─────────────────────────────────────────────────────────────────
//  category-repair-counts — size the damage the old category save did.
//  READ-ONLY. COUNTS ONLY: no amounts, dates, names or ids are selected.
//
//  Before 90fc5ecd, PATCH /transactions/:id wrote a DISPLAY name ("Shopping")
//  into categoryPrimary, where Plaid codes live. docs/m7.3-category-repair.md
//  holds a counts query and a proposed repair. This runs the counts query,
//  read out of that doc verbatim so the two cannot drift, then a finer
//  breakdown the repair decision actually needs.
//
//  Why the finer breakdown. The bug overwrote categoryPrimary ONLY;
//  categoryDetailed was never touched. The classifier reads them differently:
//    - R2's transfer signal is categoryDetailed (TRANSFER_IN_* / TRANSFER_OUT_*),
//      so a damaged transfer still carries it and still pairs;
//    - R6's income test is categoryPrimary (INCOME* or TRANSFER_IN*), so a
//      damaged inflow STOPS being income and becomes "unidentified";
//    - the spend bucket is categoryPrimary, so damaged spend is mis-bucketed.
//  So "a transfer turned into spending" is mostly not what happened. Whether
//  the transfer signal survived is reported per row group rather than assumed.
//
//  Also worth knowing when reading the result: a Plaid sync of a MODIFIED
//  transaction rewrites both codes from Plaid, which silently repairs a
//  damaged row (and loses the user's edit). So this counts damage still
//  standing, not every edit ever made.
//
//    railway run npx tsx scripts/category-repair-counts.ts --allow-remote <db host>
// ─────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { connectReadOnly, redact } from './lib/read-only-db'

const REPAIR_DOC = path.resolve(__dirname, '..', '..', 'docs', 'm7.3-category-repair.md')

const DISPLAY_NAMES = `('Housing', 'Food & Dining', 'Shopping', 'Transportation', 'Bills & Utilities',
  'Subscriptions', 'Entertainment', 'Travel', 'Debt', 'Other')`

/** The doc's section-1 query, verbatim. */
function docCountsQuery(): string {
  const md = readFileSync(REPAIR_DOC, 'utf8')
  const section = md.slice(md.search(/^## 1\. Counts only/m))
  const match = section.match(/```sql\r?\n([\s\S]*?)```/)
  if (!match) throw new Error(`no counts query under "## 1. Counts only" in ${REPAIR_DOC}; has the doc changed shape?`)
  if (!/^\s*SELECT\b/i.test(match[1])) throw new Error('the counts query is not a SELECT; refusing to run it.')
  return match[1].trim().replace(/;\s*$/, '')
}

// What each damaged row originally was, which way the money went, and whether
// the transfer signal R2 needs survived the damage.
const BREAKDOWN = `
SELECT
  CASE
    WHEN t."rawJson" IS NULL THEN 'no Plaid original'
    WHEN t."rawJson"->'personal_finance_category'->>'detailed' LIKE 'TRANSFER\\_IN%'  THEN 'transfer in'
    WHEN t."rawJson"->'personal_finance_category'->>'detailed' LIKE 'TRANSFER\\_OUT%' THEN 'transfer out'
    WHEN t."rawJson"->'personal_finance_category'->>'primary'  LIKE 'INCOME%'         THEN 'income'
    WHEN t."rawJson"->'personal_finance_category'->>'detailed' = 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' THEN 'card payment'
    ELSE 'ordinary'
  END                                                            AS was,
  CASE WHEN t.amount > 0 THEN 'out' ELSE 'in' END                AS direction,
  CASE WHEN t."categoryDetailed" ~ '^TRANSFER_(IN|OUT)_' THEN 'yes' ELSE 'no' END AS transfer_signal_kept,
  count(*)                                                       AS rows,
  count(*) FILTER (WHERE t."deletedAt" IS NULL)                  AS live,
  count(DISTINCT t."userId") FILTER (WHERE t."userId" <> 'demo-user') AS real_users,
  count(*) FILTER (WHERE t."userId" = 'demo-user')               AS demo_rows
FROM "Transaction" t
WHERE t."categoryPrimary" IN ${DISPLAY_NAMES}
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3`

function table(rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) {
    console.log('  (no rows)\n')
    return
  }
  const cols = Object.keys(rows[0])
  const cell = (v: unknown) => (typeof v === 'bigint' ? v.toString() : String(v ?? ''))
  const w = Object.fromEntries(cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => cell(r[c]).length))]))
  console.log('  ' + cols.map((c) => c.padEnd(w[c])).join('  '))
  console.log('  ' + cols.map((c) => '─'.repeat(w[c])).join('  '))
  for (const r of rows) console.log('  ' + cols.map((c) => cell(r[c]).padEnd(w[c])).join('  '))
  console.log()
}

async function main() {
  const db = await connectReadOnly('category-repair-counts')
  console.log(`\nReading ${db.database} on ${db.host} via ${db.envName} — read-only (${db.writeRefusedWith}).`)
  console.log('Counts only: no amounts, dates, names or ids.\n')

  console.log('1. The doc\'s counts query (docs/m7.3-category-repair.md, section 1), verbatim:')
  table(await db.prisma.$queryRawUnsafe(docCountsQuery()))

  console.log('2. What the damaged rows were, which way the money went, and whether R2\'s transfer signal survived:')
  const rows = await db.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(BREAKDOWN)
  table(rows)

  const n = (r: Record<string, unknown>, k: string) => Number(r[k] ?? 0)
  const sum = (pred: (r: Record<string, unknown>) => boolean, k = 'live') =>
    rows.filter(pred).reduce((s, r) => s + n(r, k), 0)
  const total = sum(() => true)
  const transfers = sum((r) => String(r.was).startsWith('transfer'))
  const transfersNoSignal = sum((r) => String(r.was).startsWith('transfer') && r.transfer_signal_kept === 'no')
  const lostIncome = sum((r) => r.direction === 'in' && (r.was === 'income' || r.was === 'transfer in'))

  console.log('Reading it (live rows only; deleted rows count toward nothing):')
  console.log(`  damaged rows still standing       ${total}`)
  console.log(`  of which were transfers           ${transfers}`)
  console.log(`    ...that lost the transfer signal ${transfersNoSignal}   ← only these can pair differently now`)
  console.log(`  inflows that stopped being income ${lostIncome}   ← income and savings rate read low by these`)
  console.log()
  await db.prisma.$disconnect()
}

main().catch((e) => {
  console.error(redact(String(e?.stack ?? e)))
  process.exit(1)
})

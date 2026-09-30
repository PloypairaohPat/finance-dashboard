// ─────────────────────────────────────────────────────────────────
//  d1-rent-pair — show the rent-coded pair D1 is waiting on. READ-ONLY.
//
//  Calibration found a same-day, exact-amount pair across two of one user's
//  own accounts: an outflow coded RENT_AND_UTILITIES and an inflow coded
//  TRANSFER_IN. Under D1 (a transfer signal on BOTH legs) it is rent plus an
//  income transfer; under an either-leg rule it would be one internal
//  transfer. This prints the pair so the decision can be made from the rows
//  themselves. It decides nothing.
//
//  The pairing is not re-derived here. The CTEs are read out of
//  docs/m7.3-calibration.sql — everything from `WITH` up to `results AS (` —
//  so this finds exactly the pairs calibration counted. Only the final SELECT
//  is new: pairs whose outflow is RENT_AND_UTILITIES* and whose inflow is
//  TRANSFER_IN*. Every match is shown, not just the first.
//
//  Prints real transaction data TO THE TERMINAL ONLY. Do not redirect it into
//  the repo, which is public.
//
//    railway run npx tsx scripts/d1-rent-pair.ts --allow-remote <db host>
// ─────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { connectReadOnly, redact } from './lib/read-only-db'

const CALIBRATION_SQL = path.resolve(__dirname, '..', '..', 'docs', 'm7.3-calibration.sql')

/** The calibration query's CTEs, verbatim, as a WITH clause ready for a new final SELECT. */
function calibrationCtes(): string {
  const sql = readFileSync(CALIBRATION_SQL, 'utf8')
  const start = sql.search(/^WITH\b/m)
  const end = sql.search(/^results AS \(/m)
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`could not find "WITH … results AS (" in ${CALIBRATION_SQL}; has the file changed shape?`)
  }
  // Drop the trailing comma after the last CTE kept (paired_in).
  return sql.slice(start, end).trimEnd().replace(/,$/, '')
}

async function main() {
  const db = await connectReadOnly('d1-rent-pair')
  console.log(`\nReading ${db.database} on ${db.host} via ${db.envName} — read-only (${db.writeRefusedWith}).`)
  console.log('Real transaction data follows. Terminal only; do not save it into the repo.\n')

  const pairs = await db.prisma.$queryRawUnsafe<Array<{
    user_n: bigint; out_id: string; in_id: string; out_cat: string; in_cat: string; gap: number
  }>>(`${calibrationCtes()}
SELECT p.user_n, p.out_id, p.in_id, p.out_cat, p.in_cat, p.gap
FROM pairs p
WHERE p.out_cat ~* '^RENT_AND_UTILITIES'
  AND p.in_cat  ~* '^TRANSFER_IN'
ORDER BY p.user_n, p.out_id`)

  console.log(`${pairs.length} pair(s) match: RENT_AND_UTILITIES outflow ↔ TRANSFER_IN inflow, as calibration pairs them.\n`)
  if (pairs.length === 0) {
    await db.prisma.$disconnect()
    return
  }

  const { classifyWindow } = await import('../src/services/classification.service')
  const { getPeriodStartDay } = await import('../src/services/user.service')
  const DAY_MS = 86_400_000

  for (const [n, p] of pairs.entries()) {
    const legs = await db.prisma.transaction.findMany({
      where: { id: { in: [p.out_id, p.in_id] } },
      include: { account: { select: { name: true, mask: true, type: true, subtype: true } } },
    })
    const byId = new Map(legs.map((l) => [l.id, l]))
    const out = byId.get(p.out_id)!
    const inn = byId.get(p.in_id)!

    // Classified with the same padding the app uses, so the verdict printed is
    // the verdict every screen shows — pairs straddling the window included.
    const dates = [out.date.getTime(), inn.date.getTime()]
    const startDay = await getPeriodStartDay(out.userId)
    const { rows } = await classifyWindow(out.userId, {
      since: new Date(Math.min(...dates) - DAY_MS),
      until: new Date(Math.max(...dates) + DAY_MS),
      startDay,
    })
    const verdicts = new Map(rows.map((r) => [r.id, r.verdict]))

    console.log(`── pair ${n + 1} of ${pairs.length} · user_n ${p.user_n} (${out.userId.slice(0, 16)}…) · ${p.gap} day(s) apart ──`)
    for (const [label, t] of [['OUT', out], ['IN ', inn]] as const) {
      const raw = (t.rawJson ?? {}) as Record<string, any>
      const pfc = raw.personal_finance_category ?? {}
      const cps: Array<{ name?: string; type?: string }> = Array.isArray(raw.counterparties) ? raw.counterparties : []
      const v = verdicts.get(t.id)
      console.log(`  ${label}  ${t.date.toISOString().slice(0, 10)}  ${Number(t.amount).toFixed(2).padStart(10)}  (Plaid sign: + out, − in)`)
      console.log(`        account      ${t.account.name}${t.account.mask ? ` ••${t.account.mask}` : ''}  (${t.account.type}/${t.account.subtype ?? '?'})`)
      console.log(`        category     ${t.categoryPrimary ?? '(none)'} > ${t.categoryDetailed ?? '(none)'}   confidence ${pfc.confidence_level ?? '(missing)'}`)
      console.log(`        merchant     ${t.merchantName ?? '(none)'}`)
      console.log(`        counterparty ${cps.length ? cps.map((c) => `${c.name ?? '(no name)'} [${c.type ?? '?'}]`).join(', ') : '(none)'}`)
      console.log(`        description  ${t.name}`)
      if (raw.original_description && raw.original_description !== t.name) {
        console.log(`        original     ${raw.original_description}`)
      }
      console.log(`        pending      ${t.pending}`)
      console.log(`        classifier   ${v ? `${v.kind} · rule R${v.rule} · ${v.mechanism}` : '(not classified — outside the window?)'}`)
      if (v) console.log(`        reason       ${v.reason}`)
    }
    console.log()
  }
  await db.prisma.$disconnect()
}

main().catch((e) => {
  console.error(redact(String(e?.stack ?? e)))
  process.exit(1)
})

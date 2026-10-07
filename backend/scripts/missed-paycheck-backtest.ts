// ─────────────────────────────────────────────────────────────────
//  missed-paycheck-backtest — what the proposed missed-paycheck rule (M7.6
//  PR 6, docs/m7.6-missed-paycheck.md) would have done on our history.
//
//  READ-ONLY, and stores nothing. Reads stored streams, Items and the user's
//  transactions on the read-only connection (scripts/lib/read-only-db.ts).
//  No Plaid calls, no decryption.
//
//  Per user: inflow streams, and why each one does or doesn't qualify; for each
//  qualifying stream, every past payday its deposits imply, how pay actually
//  came (on time, late, never) and whether the rule would have fired, at
//  grace periods of 1, 2 and 3 banking days; how many of those it would have
//  fired on were rescued by a salary deposit outside the stream; how Plaid's
//  predicted date compares with ours; and what the rule would say today.
//
//  Counts only. Users appear as "user N"; no names, amounts, ids or dates.
//
//    railway run npx tsx scripts/missed-paycheck-backtest.ts --allow-remote <db host>
// ─────────────────────────────────────────────────────────────────

import { connectReadOnly, redact } from './lib/read-only-db'
import { dayOf } from './lib/businessDays'
import {
  HALF_PERIOD_DAYS, SALARY_CODES, deadline, exclusionOf, nominalSchedule, paydays, wouldFire, type PayFrequency,
} from './lib/paycheckBacktest'

const GRACES = [1, 2, 3] as const
const DAY = 86_400_000
/** A deposit outside the stream counts as this payday's only within this share of the stream's usual amount. */
const AMOUNT_TOLERANCE = 0.3

type Counter = Map<string, number>
const bump = (m: Counter, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n)
const show = (title: string, m: Counter) => {
  const rows = [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  console.log(`  ${title}: ${rows.length === 0 ? '(none)' : rows.map(([k, n]) => `${k} ${n}`).join(' | ')}`)
}
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? 0 : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

async function main() {
  const db = await connectReadOnly('missed-paycheck-backtest')
  console.log(`\nReading ${db.database} on ${db.host} via ${db.envName} — read-only (${db.writeRefusedWith}).`)
  console.log('Stored streams and transactions only; no Plaid calls. Counts only.\n')

  const { DEMO_USER_ID } = await import('../src/middleware/auth')
  const now = Date.now()
  const today = dayOf(now)

  const users = await db.prisma.user.findMany({
    where: { id: { not: DEMO_USER_ID }, plaidItems: { some: {} } },
    select: { id: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  console.log(`${users.length} non-demo user(s) with Items.\n`)

  for (const [i, user] of users.entries()) {
    console.log(`user ${i + 1}`)
    const [streams, items, accounts] = await Promise.all([
      db.prisma.recurringStream.findMany({ where: { userId: user.id, direction: 'inflow' } }),
      db.prisma.plaidItem.findMany({ where: { userId: user.id }, select: { id: true, lastSyncedAt: true, streamsRefreshedAt: true } }),
      db.prisma.account.findMany({ where: { userId: user.id }, select: { id: true, plaidAccountId: true } }),
    ])
    const itemOf = new Map(items.map((it) => [it.id, it]))
    const accountId = new Map(accounts.map((a) => [a.plaidAccountId, a.id]))

    const why: Counter = new Map()
    const qualifying = streams.filter((s) => {
      const e = exclusionOf(s)
      bump(why, e ?? 'qualifies')
      return e === null
    })
    console.log(`  inflow streams: ${streams.length}`)
    show('by qualification', why)

    const freq: Counter = new Map()
    const outcome: Counter = new Map()
    const fired: Counter = new Map()
    const rescued: Counter = new Map()
    const plaidVsOurs: Counter = new Map()
    const todayVerdict: Counter = new Map()
    let pendingDeposits = 0

    for (const s of qualifying) {
      const f = s.frequency as PayFrequency
      bump(freq, f)
      const rows = await db.prisma.transaction.findMany({
        where: { userId: user.id, deletedAt: null, plaidTransactionId: { in: s.plaidTransactionIds } },
        select: { id: true, date: true, amount: true, pending: true },
      })
      pendingDeposits += rows.filter((r) => r.pending).length
      const deposits = rows.map((r) => r.date.getTime())
      const usual = median(rows.map((r) => Math.abs(Number(r.amount))))
      const item = itemOf.get(s.plaidItemId)
      // History is complete only up to the Item's last sync: paydays whose
      // deadline (at the widest grace) is after it are too recent to judge.
      const dataUntil = item?.lastSyncedAt ? dayOf(item.lastSyncedAt) : today
      const judged = paydays(deposits, f, today).filter((p) => deadline(p.expected, 3) <= dataUntil)

      // Salary-coded deposits into the same account that Plaid didn't put in the stream.
      const inStream = new Set(rows.map((r) => r.id))
      const acct = accountId.get(s.plaidAccountId)
      const others = acct
        ? (await db.prisma.transaction.findMany({
            where: { userId: user.id, accountId: acct, deletedAt: null, amount: { lt: 0 }, categoryDetailed: { in: [...SALARY_CODES] } },
            select: { id: true, date: true, amount: true },
          })).filter((r) => !inStream.has(r.id))
        : []

      for (const p of judged) {
        bump(outcome, p.lateBy === null ? 'never' : p.lateBy === 0 ? 'on time' : `late ${Math.min(p.lateBy, 4) === 4 ? '4+' : p.lateBy} bd`)
        for (const g of GRACES) {
          if (!wouldFire(p, g)) continue
          bump(fired, `grace ${g}`)
          const by = deadline(p.expected, g)
          const rescue = others.some((r) => {
            const d = dayOf(r.date)
            const near = d >= p.expected - HALF_PERIOD_DAYS[f] * DAY && d <= by
            return near && usual > 0 && Math.abs(Math.abs(Number(r.amount)) - usual) <= AMOUNT_TOLERANCE * usual
          })
          if (rescue) bump(rescued, `grace ${g}`)
        }
      }

      // Plaid's predicted next payday against our nominal schedule's.
      const lastDeposit = Math.max(...deposits, 0)
      const ours = nominalSchedule(deposits, f, today + 62 * DAY).find((d) => d > lastDeposit + HALF_PERIOD_DAYS[f] * DAY / 2)
      if (!s.predictedNextDate) bump(plaidVsOurs, 'plaid has none')
      else if (ours === undefined) bump(plaidVsOurs, 'ours has none')
      else {
        const diff = Math.abs(dayOf(s.predictedNextDate) - ours) / DAY
        bump(plaidVsOurs, diff === 0 ? 'same day' : diff <= 3 ? '1-3 days apart' : '4+ days apart')
      }

      // What the rule would say today, at each grace, on Plaid's predicted date.
      if (s.predictedNextDate) {
        const expected = dayOf(s.predictedNextDate)
        for (const g of GRACES) {
          const by = deadline(expected, g)
          if (today <= by) { bump(todayVerdict, `grace ${g}: not due`); continue }
          const fresh = item?.lastSyncedAt && item.streamsRefreshedAt && dayOf(item.lastSyncedAt) > by && dayOf(item.streamsRefreshedAt) > by
          if (!fresh) { bump(todayVerdict, `grace ${g}: withheld, data behind`); continue }
          const arrived = deposits.some((d) => dayOf(d) >= expected - HALF_PERIOD_DAYS[f] * DAY && dayOf(d) <= by)
          bump(todayVerdict, `grace ${g}: ${arrived ? 'arrived' : 'would fire'}`)
        }
      }
    }

    console.log(`  qualifying: ${qualifying.length}`)
    if (qualifying.length > 0) {
      show('by frequency', freq)
      console.log(`  pending deposits in qualifying streams: ${pendingDeposits}`)
      show('past paydays, how pay came', outcome)
      show('past paydays the rule would have fired on', fired)
      show('...of which a salary deposit outside the stream would have satisfied', rescued)
      show("Plaid's predicted next payday vs ours", plaidVsOurs)
      show('today, on Plaid\'s predicted date', todayVerdict)
    }
    console.log()
  }
  await db.prisma.$disconnect()
}

main().catch((e) => {
  console.error(redact(String(e?.stack ?? e)))
  process.exit(1)
})

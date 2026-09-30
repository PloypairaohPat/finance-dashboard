// ─────────────────────────────────────────────────────────────────
//  d1-before-after — what R2's same-day pass (D1) does to one user's figures.
//  READ-ONLY. Prints real figures to the terminal only; never save the output
//  into the repo, which is public.
//
//  Both columns come from the app's real pipelines — classifyWindow, the
//  savings-rate floor, the financial score — run twice, once with the pass
//  switched off through withClassifierSettings. Nothing is re-derived here, and
//  the user's stored settings are read, not changed.
//
//  Attribution, as in the M7.3 reconciler: in every period, income must fall by
//  exactly the inflows the pass paired and spend by exactly the outflows, so
//  net saved does not move. Anything else is printed as unexplained and the
//  run exits non-zero.
//
//    railway run npx tsx scripts/d1-before-after.ts --user <id> --allow-remote <db host>
// ─────────────────────────────────────────────────────────────────

import { connectReadOnly, flag, makeRefuse, redact } from './lib/read-only-db'

const SCRIPT = 'd1-before-after'
const refuse: (message: string) => never = makeRefuse(SCRIPT)
const PERIODS = 12
const money = (n: number) => (n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`)
const pct = (n: number | null) => (n === null ? '—' : `${n.toFixed(1)}%`)
const round2 = (n: number) => Math.round(n * 100) / 100

async function main() {
  const user = flag('user')
  if (!user || user.startsWith('--')) refuse('--user <id> is required.')

  const db = await connectReadOnly(SCRIPT)
  const { recentPeriods, fromDateKey, periodKeyOf } = await import('../src/lib/period')
  const { classifyWindow, withClassifierSettings, incomeForPeriod, spendForPeriod, savingsRateFor } =
    await import('../src/services/classification.service')
  const { fetchFinancialScore } = await import('../src/services/score.service')
  const { getPeriodStartDay } = await import('../src/services/user.service')

  const stored = await db.prisma.user.findUnique({
    where: { id: user },
    select: { paymentAppInflowsAreIncome: true },
  })
  if (!stored) refuse(`no user "${user}" in this database.`)
  const startDay = await getPeriodStartDay(user)
  const periods = recentPeriods(new Date(), startDay, PERIODS)

  const measure = (sameDayTransferPairs: boolean) =>
    withClassifierSettings({ paymentAppInflowsAreIncome: stored.paymentAppInflowsAreIncome, sameDayTransferPairs }, async () => {
      const { rows, paymentAppByPeriod } = await classifyWindow(user, {
        since: fromDateKey(periods[0].start),
        until: fromDateKey(periods[periods.length - 1].end),
        startDay,
      })
      const completed: number[] = []
      const byPeriod = periods.map((p) => {
        const income = incomeForPeriod(rows, p.key, startDay)
        const spend = spendForPeriod(rows, p.key, startDay, paymentAppByPeriod)
        const rate = savingsRateFor(income, round2(income - spend), completed)
        if (p !== periods[periods.length - 1]) completed.push(income)
        return { key: p.key, income, spend, net: round2(income - spend), rate: rate.rate }
      })
      return { rows, byPeriod, score: await fetchFinancialScore(user) }
    })

  const before = await measure(false)
  const after = await measure(true)

  // The rows the pass paired, and what each counted as before it did.
  const verdictBefore = new Map(before.rows.map((r) => [r.id, r.verdict]))
  const moved = after.rows.filter((r) => r.verdict.mechanism === 'internal-transfer-same-day')

  console.log(`\n${SCRIPT} — ${user.slice(0, 12)}… on ${db.host} (${db.envName}, read-only)`)
  console.log(`money periods start on day ${startDay}; last ${PERIODS} periods; payment-app setting ${stored.paymentAppInflowsAreIncome ? 'ON' : 'off'} (read, not changed)`)
  console.log('Real figures follow. Terminal only.\n')

  if (moved.length === 0) {
    console.log('The same-day pass pairs nothing for this user. No figure changes.\n')
    await db.prisma.$disconnect()
    return
  }

  console.log(`Rows the same-day pass pairs: ${moved.length}`)
  for (const r of moved) {
    const was = verdictBefore.get(r.id)
    console.log(`  ${periodKeyOf(r.date, startDay)}  ${r.amount > 0 ? 'out' : 'in '}  ${money(Math.abs(r.amount)).padStart(11)}  ` +
      `was ${was?.kind ?? '?'} (${was?.mechanism ?? '?'})  →  internal_transfer`)
  }
  console.log()

  const head = ['period', 'income before', 'income after', 'spend before', 'spend after', 'net before', 'net after', 'rate before', 'rate after']
  const out: string[][] = []
  const unexplained: string[] = []
  before.byPeriod.forEach((b, i) => {
    const a = after.byPeriod[i]
    const mine = moved.filter((r) => periodKeyOf(r.date, startDay) === b.key)
    if (mine.length === 0 && b.income === a.income && b.spend === a.spend) return
    out.push([b.key, money(b.income), money(a.income), money(b.spend), money(a.spend), money(b.net), money(a.net), pct(b.rate), pct(a.rate)])

    // Attribution: each paired leg leaves exactly the figure it was counted in.
    const wasIncome = round2(mine.filter((r) => verdictBefore.get(r.id)?.kind === 'income').reduce((s, r) => s - r.amount, 0))
    const wasSpend = round2(mine.filter((r) => verdictBefore.get(r.id)?.kind === 'spend').reduce((s, r) => s + r.amount, 0))
    if (Math.abs(round2(b.income - a.income) - wasIncome) >= 0.01) {
      unexplained.push(`${b.key}: income fell ${money(round2(b.income - a.income))}, but the paired inflows that were income total ${money(wasIncome)}`)
    }
    if (Math.abs(round2(b.spend - a.spend) - wasSpend) >= 0.01) {
      unexplained.push(`${b.key}: spend fell ${money(round2(b.spend - a.spend))}, but the paired outflows that were spend total ${money(wasSpend)}`)
    }
    if (Math.abs(b.net - a.net) >= 0.01) {
      unexplained.push(`${b.key}: net saved moved ${money(round2(a.net - b.net))}; the inflow-coded direction should never move it`)
    }
  })

  const widths = head.map((h, i) => Math.max(h.length, ...out.map((r) => r[i].length)))
  console.log(head.map((h, i) => h.padStart(widths[i])).join('  '))
  console.log(widths.map((w) => '─'.repeat(w)).join('  '))
  for (const r of out) console.log(r.map((c, i) => c.padStart(widths[i])).join('  '))

  console.log(`\nFinancial score: ${before.score.total} (${before.score.grade})  →  ${after.score.total} (${after.score.grade})`)
  for (const key of Object.keys(before.score.components) as Array<keyof typeof before.score.components>) {
    const b = before.score.components[key], a = after.score.components[key]
    if (b.value !== a.value) console.log(`  ${key}: ${b.value ?? '—'} → ${a.value ?? '—'}`)
  }

  console.log(unexplained.length === 0
    ? '\nEvery difference is accounted for by the rows the pass paired; net saved is unchanged in every period.\n'
    : `\n⚠ ${unexplained.length} unexplained difference(s):\n  ${unexplained.join('\n  ')}\n`)
  await db.prisma.$disconnect()
  if (unexplained.length > 0) process.exit(2)
}

main().catch((e) => {
  console.error(redact(String(e?.stack ?? e)))
  process.exit(1)
})

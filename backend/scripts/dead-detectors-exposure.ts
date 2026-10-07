// ─────────────────────────────────────────────────────────────────
//  dead-detectors-exposure — what missedPaycheck and subscriptionPriceUp
//  would fire on, per user, if they worked. READ-ONLY. COUNTS AND LABELS ONLY:
//  no amounts, dates, merchant names or ids are printed.
//
//  Both detectors have never fired (M5.8): each read a field of the
//  subscription analysis that doesn't exist, through an `any` cast. Going from
//  never-fires to firing adds alerts to real users' bells, so this sizes that
//  before anything is built.
//
//  Paychecks. The classifier's income is the one definition of income; a
//  paycheck is a narrower thing inside it. This reports income by Plaid's
//  detailed code, so salary can be told apart from interest, tax refunds and
//  unpaired transfers that the classifier also counts as income. Real data uses
//  Plaid's newer codes (INCOME_SALARY, INCOME_CONTRACTOR), not INCOME_WAGES, so
//  both generations are matched, and contractor income is reported separately:
//  it is work income, but it isn't on a schedule. For each, per payer, a cadence
//  label and whether a "the next one is late" rule would fire today: at least 3
//  deposits, and more days since the last than the longest recent gap plus a
//  3-day grace.
//
//  Price rises. The subscription analysis, from stored data alone, which is all
//  a detector may read. (It took a Plaid client until M7.6 PR 0, which removed
//  the never-productive Plaid half; so did this script's old --with-plaid.)
//
//  Also counted: alerts of either kind already stored (expected: none).
//
//    railway run npx tsx scripts/dead-detectors-exposure.ts --allow-remote <db host>
// ─────────────────────────────────────────────────────────────────

import { connectReadOnly, redact } from './lib/read-only-db'

const DAY_MS = 86_400_000
const GRACE_DAYS = 3

function table(title: string, rows: Array<Record<string, string | number>>): void {
  console.log(title)
  if (rows.length === 0) {
    console.log('  (none)\n')
    return
  }
  const cols = Object.keys(rows[0])
  const w = Object.fromEntries(cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => String(r[c]).length))]))
  console.log('  ' + cols.map((c) => c.padEnd(w[c])).join('  '))
  console.log('  ' + cols.map((c) => '─'.repeat(w[c])).join('  '))
  for (const r of rows) console.log('  ' + cols.map((c) => String(r[c]).padEnd(w[c])).join('  '))
  console.log()
}

function cadence(gaps: number[]): string {
  if (gaps.length === 0) return 'single'
  const sorted = [...gaps].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const spread = sorted[sorted.length - 1] - sorted[0]
  const shape = median <= 8 ? 'weekly' : median <= 16 ? 'biweekly/semi-monthly' : median <= 35 ? 'monthly' : 'longer'
  return spread <= 6 ? shape : `${shape}, irregular`
}

async function main() {
  const db = await connectReadOnly('dead-detectors-exposure')
  console.log(`\nReading ${db.database} on ${db.host} via ${db.envName} — read-only (${db.writeRefusedWith}).`)
  console.log('Counts and labels only.\n')

  const { classifyWindow } = await import('../src/services/classification.service')
  const { getPeriodStartDay } = await import('../src/services/user.service')
  const { analyseWithDetector } = await import('../src/services/subscriptions.service')

  const users = await db.prisma.user.findMany({
    where: { transactions: { some: {} } },
    select: { id: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })

  for (const [idx, { id: userId }] of users.entries()) {
    const label = userId === 'demo-user' ? 'demo-user' : `user_n ${idx + 1} (${userId.slice(0, 12)}…)`
    console.log(`════ ${label} ════\n`)
    const now = new Date()

    const stored = await db.prisma.alert.groupBy({
      by: ['kind'],
      where: { userId, kind: { in: ['missed_paycheck', 'subscription_price_up'] } },
      _count: true,
    })
    console.log(`Alerts of these kinds already stored: ${stored.length === 0 ? 'none' : stored.map((s) => `${s.kind} ${s._count}`).join(', ')}\n`)

    // ── income, by what it is ──────────────────────────────────────
    const first = await db.prisma.transaction.findFirst({ where: { userId, deletedAt: null }, orderBy: { date: 'asc' }, select: { date: true } })
    if (!first) continue
    const startDay = await getPeriodStartDay(userId)
    const { rows } = await classifyWindow(userId, { since: first.date, until: new Date(now.getTime() + DAY_MS), startDay })
    const income = rows.filter((r) => r.verdict.kind === 'income')
    const byCode: Record<string, number> = {}
    for (const r of income) {
      const code = (r.categoryDetailed ?? '(none)').toUpperCase()
      byCode[code] = (byCode[code] ?? 0) + 1
    }
    table('Rows the classifier counts as income, by Plaid detailed code:',
      Object.entries(byCode).sort((a, b) => b[1] - a[1]).map(([code, n]) => ({ detailed_code: code, rows: n })))

    // ── paychecks: cadence per payer, and would "next one is late" fire? ─
    const perPayer = (codes: string[], title: string) => {
      const mine = income.filter((r) => codes.includes((r.categoryDetailed ?? '').toUpperCase()) && !r.pending)
      const payers = new Map<string, Date[]>()
      for (const r of mine) {
        const k = r.merchantLabel.toLowerCase()
        payers.set(k, [...(payers.get(k) ?? []), r.date])
      }
      table(title, [...payers.values()].sort((a, b) => b.length - a.length).map((dates, i) => {
        const days = dates.map((d) => Math.floor(d.getTime() / DAY_MS)).sort((a, b) => a - b)
        const gaps = days.slice(1).map((d, j) => d - days[j])
        const recent = gaps.slice(-6)
        const sinceLast = Math.floor(now.getTime() / DAY_MS) - days[days.length - 1]
        const wouldFire = days.length >= 3 && sinceLast > Math.max(...recent) + GRACE_DAYS
        return {
          payer: `payer ${String.fromCharCode(65 + i)}`,
          deposits: dates.length,
          cadence: cadence(recent),
          would_fire_today: wouldFire ? 'YES' : 'no',
        }
      }))
    }
    perPayer(['INCOME_SALARY', 'INCOME_WAGES'], 'Salary deposits (classifier income AND INCOME_SALARY / INCOME_WAGES), per payer:')
    perPayer(['INCOME_CONTRACTOR'], 'Contractor income (classifier income AND INCOME_CONTRACTOR), per payer:')

    // ── price rises, from stored data alone ───────────────────────
    const report = async (name: string) => {
      try {
        const a = await analyseWithDetector(userId)
        const streams = [...a.subscriptions, ...a.bills]
        return {
          source: name,
          subscriptions: a.subscriptions.length,
          bills: a.bills.length,
          with_price_change: streams.filter((s) => s.priceChange !== null).length,
          rises: streams.filter((s) => (s.priceChange?.pctChange ?? 0) > 0).length,
          rises_among_subscriptions_only: a.subscriptions.filter((s) => (s.priceChange?.pctChange ?? 0) > 0).length,
        }
      } catch (e: any) {
        return { source: name, subscriptions: '—', bills: '—', with_price_change: '—', rises: `failed: ${redact(String(e?.response?.data?.error_code ?? e?.code ?? 'error'))}`, rises_among_subscriptions_only: '—' }
      }
    }
    const sources = [await report('stored data only')]
    table('Recurring streams and price rises (subscriptionPriceUp\'s input):', sources)
  }

  await db.prisma.$disconnect()
}

main().catch((e) => {
  console.error(redact(String(e?.stack ?? e)))
  process.exit(1)
})

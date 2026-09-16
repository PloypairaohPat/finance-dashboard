// ─────────────────────────────────────────────────────────────────
//  scripts/verify-figures.ts — every endpoint still agrees with the rules
//
//  READ-ONLY, local database only. Successor to scripts/reconcile-m73.ts, which
//  compared the classifier against the pre-M7.3 code and retired with it: once
//  the legacy paths were deleted there was no "before" left to compare against.
//  Its final output is kept as docs/m7.3-reconciliation.md.
//
//  What remains worth checking every time is the third of its three checks, and
//  it is the one that catches real mistakes: each endpoint is called live and
//  compared against the figure computed straight from the classifier. If an
//  endpoint drifts — sums its own rows, forgets the payment-app cap, filters
//  pending differently — this fails instead of quietly reporting a plausible
//  number.
//
//  Run:
//    cd backend
//    npm run db:guard && npx dotenv -e .env.dev -- tsx scripts/verify-figures.ts
// ─────────────────────────────────────────────────────────────────

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
let host = ''
try {
  host = new URL(process.env.DATABASE_URL ?? '').hostname
} catch {
  /* handled below */
}
if (!LOCAL_HOSTS.has(host)) {
  console.error(`[verify-figures] Refusing: DATABASE_URL host "${host || '(unparseable)'}" is not local.`)
  process.exit(1)
}

const DEMO = 'demo-user'
const cents = (n: number) => Math.round(n * 100)
const fmt = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`

interface Check {
  endpoint: string
  figure: string
  fromRules: number
  fromEndpoint: number
}

async function main() {
  const { default: prisma } = await import('../src/lib/prisma')
  const { PAYMENTS_TO_PEOPLE } = await import('../src/lib/classifier')
  const {
    classifyWindow,
    incomeForPeriod,
    spendForPeriod,
    spendByBucket,
    spendByBucketForRows,
  } = await import('../src/services/classification.service')
  const period = await import('../src/lib/period')
  const { fetchInsights } = await import('../src/services/insights.service')
  const { fetchCashFlow } = await import('../src/services/cashflow.service')
  const { fetchMonthlyTotals, fetchCategoryComparison, fetchCurrentPeriodCategorySpend } =
    await import('../src/services/transactions.service')
  const { fetchBudgetsWithSpend } = await import('../src/services/budgets.service')
  const { fetchFirstTransactionDate } = await import('../src/services/activity.service')

  const now = new Date()
  const user = await prisma.user.findUnique({ where: { id: DEMO }, select: { periodStartDay: true } })
  const startDay = user?.periodStartDay ?? 1
  const firstTx = await fetchFirstTransactionDate(DEMO)

  const checks: Check[] = []
  const add = (endpoint: string, figure: string, fromRules: number, fromEndpoint: number) =>
    checks.push({ endpoint, figure, fromRules, fromEndpoint })

  // ── the figures, computed straight from the rules ───────────────
  const cashPeriods = period.periodsFromFirstActivity(period.recentPeriods(now, startDay, 6), firstTx)
  const trendPeriods = period.periodsFromFirstActivity(period.recentPeriods(now, startDay, 12), firstTx)
  const comparisonPeriods = period.periodsFromFirstActivity(period.recentPeriods(now, startDay, 3), firstTx)
  const [thisPeriod] = period.recentPeriods(now, startDay, 1)

  const widest = trendPeriods.length > 0 ? trendPeriods : cashPeriods
  const { rows, paymentAppByPeriod } = await classifyWindow(DEMO, {
    since: period.fromDateKey(widest[0].start),
    until: period.fromDateKey(widest[widest.length - 1].end),
    startDay,
  })

  // ── the same figures, as the endpoints report them ──────────────
  const [insights, cashflow, trends, comparison, breakdown, budgets] = await Promise.all([
    fetchInsights(DEMO, startDay, now),
    fetchCashFlow(DEMO, 6, startDay, now),
    fetchMonthlyTotals(DEMO, 12, startDay, now),
    fetchCategoryComparison(DEMO, 3, startDay, now),
    fetchCurrentPeriodCategorySpend(DEMO, startDay, now),
    fetchBudgetsWithSpend(DEMO, undefined, startDay, now),
  ])

  add('/insights', 'income', incomeForPeriod(rows, thisPeriod.key, startDay), insights.summary.income)
  add(
    '/insights',
    'expenses',
    spendForPeriod(rows, thisPeriod.key, startDay, paymentAppByPeriod),
    insights.summary.expenses,
  )

  for (const p of cashflow.cashflow) {
    add('/cashflow', `income ${p.key}`, incomeForPeriod(rows, p.key, startDay), p.income)
    add(
      '/cashflow',
      `expenses ${p.key}`,
      spendForPeriod(rows, p.key, startDay, paymentAppByPeriod),
      p.expenses,
    )
  }

  for (const t of trends) {
    add('/transactions/trends', t.key, spendForPeriod(rows, t.key, startDay, paymentAppByPeriod), t.total)
  }

  for (const p of comparisonPeriods) {
    const expected = spendByBucket(rows, p.key, startDay, paymentAppByPeriod, PAYMENTS_TO_PEOPLE)
    const reported = comparison.find((x) => x.key === p.key)?.categories ?? {}
    for (const key of new Set([...Object.keys(expected), ...Object.keys(reported)])) {
      add('/categories/comparison', `${p.key} | ${key}`, expected[key] ?? 0, reported[key] ?? 0)
    }
  }

  {
    const expected = spendByBucket(rows, thisPeriod.key, startDay, paymentAppByPeriod, PAYMENTS_TO_PEOPLE)
    const reported = new Map(breakdown.categories.map((c) => [c.category, c.amount]))
    for (const key of new Set([...Object.keys(expected), ...reported.keys()])) {
      add('/categories', key, expected[key] ?? 0, reported.get(key) ?? 0)
    }
  }

  {
    // Budgets run on their own period window, so classify that window directly.
    const { rows: budgetRows } = await classifyWindow(DEMO, {
      since: period.fromDateKey(thisPeriod.start),
      until: period.fromDateKey(thisPeriod.end),
      startDay,
    })
    const expected = spendByBucketForRows(budgetRows, PAYMENTS_TO_PEOPLE)
    for (const b of budgets) add('/budgets', b.category, expected[b.category] ?? 0, b.currentSpend)
  }

  // ── report ──────────────────────────────────────────────────────
  const mismatches = checks.filter((c) => cents(c.fromRules) !== cents(c.fromEndpoint))

  console.log(`\nChecked ${checks.length} figures across 6 endpoints, period start day ${startDay}.\n`)
  if (mismatches.length === 0) {
    console.log('Every endpoint agrees with the classifier, to the cent.')
  } else {
    console.log('| Endpoint | Figure | From the rules | From the endpoint |')
    console.log('|---|---|---:|---:|')
    for (const m of mismatches) {
      console.log(`| ${m.endpoint} | ${m.figure} | ${fmt(m.fromRules)} | ${fmt(m.fromEndpoint)} |`)
    }
    console.error(`\n[verify-figures] FAILED: ${mismatches.length} figure(s) disagree with the rules.`)
    process.exitCode = 1
  }

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('[verify-figures] failed:', err)
  process.exit(1)
})

// Module scope: these scripts declare top-level names (LOCAL_HOSTS, main) and
// would otherwise collide with each other in a shared global scope.
export {}

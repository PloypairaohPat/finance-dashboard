// ─────────────────────────────────────────────────────────────────
//  scripts/verify-s7-demo.ts — re-verify plan §7 against the DEMO SEED
//
//  READ-ONLY. Computes each §7 figure the way the app computes it, for the
//  demo user in the LOCAL dev database, so the notes can say whether an
//  observation reproduces from demo data at all. Nothing is fixed or written:
//  the alert detectors are called as pure functions, not through runDetectors
//  (which would upsert rows).
//
//  Run (guarded — refuses any non-local database):
//    cd backend
//    npm run db:dev:seed           # deterministic demo data, dated relative to today
//    npm run db:guard && npx dotenv -e .env.dev -- tsx scripts/verify-s7-demo.ts
//
//  Caveat: the seed's RNG is deterministic, but its dates are relative to the
//  day it runs and the current month is truncated at today, so exact dollar
//  figures differ by seed date. Structural results (whether a figure CAN
//  appear) do not.
// ─────────────────────────────────────────────────────────────────

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
const dbUrl = process.env.DATABASE_URL ?? ''
let host = ''
try { host = new URL(dbUrl).hostname } catch { /* invalid */ }
if (!LOCAL_HOSTS.has(host)) {
  console.error(`[verify-s7-demo] Refusing: DATABASE_URL host "${host || '(unparseable)'}" is not local.`)
  process.exit(1)
}

async function main() {
  const { default: prisma } = await import('../src/lib/prisma')
  const { fetchInsights } = await import('../src/services/insights.service')
  const { fetchCashFlow } = await import('../src/services/cashflow.service')
  const { fetchMonthlyTotals, fetchCategoryComparison, fetchCategorySpend } = await import('../src/services/transactions.service')
  const { fetchBudgetsWithSpend } = await import('../src/services/budgets.service')
  const { detectOverspending } = await import('../src/services/alerts/detectors/overspending')
  const { detectBudgetExceeded, detectBudgetProjectedOver } = await import('../src/services/alerts/detectors/budgetStatus')

  const DEMO = 'demo-user'
  const now = new Date()
  const out: Record<string, unknown> = { ranAt: now.toISOString(), database: `${host}${new URL(dbUrl).pathname}` }

  // ── Shape of the seed ─────────────────────────────────────────
  const all = await prisma.transaction.findMany({
    where: { userId: DEMO, deletedAt: null },
    select: { date: true, amount: true, categoryPrimary: true, pending: true },
    orderBy: { date: 'asc' },
  })
  const byCat: Record<string, number> = {}
  for (const t of all) byCat[t.categoryPrimary ?? '(null)'] = (byCat[t.categoryPrimary ?? '(null)'] ?? 0) + 1
  out.seed = {
    transactions: all.length,
    firstDate: all[0]?.date.toISOString().slice(0, 10),
    // Array.prototype.at needs lib es2022; this file is compiled against ES2020.
    lastDate: all[all.length - 1]?.date.toISOString().slice(0, 10),
    pending: all.filter((t) => t.pending).length,
    transfers: all.filter((t) => /^TRANSFER/i.test(t.categoryPrimary ?? '')).length,
    loanOrCardPayments: all.filter((t) => /^LOAN_PAYMENTS/i.test(t.categoryPrimary ?? '')).length,
    categories: byCat,
    budgets: (await prisma.budget.findMany({ where: { userId: DEMO }, select: { category: true, monthlyLimit: true } }))
      .map((b) => `${b.category} $${b.monthlyLimit.toString()}`),
  }

  // ── §7.1 income $50 vs $550 ───────────────────────────────────
  const insights = await fetchInsights(DEMO, 1, now)
  const cash = await fetchCashFlow(DEMO, 6, 1, now)
  out.s7_income = {
    insightsThisMonth: { income: insights.summary.income, expenses: insights.summary.expenses, period: insights.summary.period.label },
    cashflowByMonth: cash.cashflow.map((c) => ({ month: c.label, income: c.income, expenses: c.expenses, inProgress: c.inProgress })),
  }

  // ── §7.2 Food & Dining $288 (budget) vs $313 (alert) vs $313.33 (MoM) ──
  const comparison = await fetchCategoryComparison(DEMO, 3, 1, now)
  const breakdown = await fetchCategorySpend(DEMO)
  const budgets = await fetchBudgetsWithSpend(DEMO)
  // M7.3: detectors run on classified rows, so build the context the same way
  // the dispatcher does rather than hand-rolling one that no longer matches.
  const { loadContext } = await import('../src/services/alerts/dispatcher')
  const ctx = await loadContext(DEMO)
  const detected = [
    ...(await detectOverspending(ctx)),
    ...(await detectBudgetExceeded(ctx)),
    ...(await detectBudgetProjectedOver(ctx)),
  ]
  out.s7_foodAndDining = {
    monthOverMonth: comparison.map((p) => ({ month: p.label, foodAndDining: p.categories['Food & Dining'] ?? 0, inProgress: p.inProgress })),
    spendingBreakdownThisMonth: breakdown.find((c) => c.category === 'Food & Dining')?.amount ?? 0,
    budgetCards: budgets.map((b) => ({ category: b.category, currentSpend: b.currentSpend, limit: b.monthlyLimit })),
    detectorAlertsNow: detected.map((a) => ({ kind: a.kind, title: a.title, body: a.body })),
    seededAlerts: (await prisma.alert.findMany({ where: { userId: DEMO, fingerprint: { startsWith: 'demo-' } }, select: { title: true, body: true } })),
  }

  // ── §7.3 savings rate -8431.6% ────────────────────────────────
  out.s7_savingsRate = {
    thisMonth: insights.summary.savingsRate,
    note: 'savingsRate = netSaved / income * 100, with income = |sum of negative amounts| this month',
  }

  // ── §7.4 Monthly Spending climbing to ~$16k ───────────────────
  const trends = await fetchMonthlyTotals(DEMO, 12, 1, now)
  // The pre-M7.2 query, reproduced exactly: cutoff = now minus 12 months,
  // grouped by toISOString().slice(0, 7), months without data omitted.
  const cutoff = new Date(now); cutoff.setMonth(cutoff.getMonth() - 12)
  const legacyRows = await prisma.transaction.findMany({
    where: { userId: DEMO, deletedAt: null, pending: false, amount: { gt: 0 }, date: { gte: cutoff } },
    select: { date: true, amount: true },
  })
  const legacy: Record<string, number> = {}
  for (const r of legacyRows) legacy[r.date.toISOString().slice(0, 7)] = (legacy[r.date.toISOString().slice(0, 7)] ?? 0) + r.amount.toNumber()
  out.s7_monthlySpending = {
    legacyPreM72: Object.entries(legacy).sort().map(([m, t]) => ({ month: m, total: Math.round(t * 100) / 100 })),
    currentM72: trends.filter((t) => t.txCount > 0).map((t) => ({ month: t.label, total: t.total, inProgress: t.inProgress })),
    maxMonthlyTotal: Math.max(0, ...Object.values(legacy)),
  }

  console.log(JSON.stringify(out, null, 2))
  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('[verify-s7-demo] failed:', err)
  process.exit(1)
})

// Module scope: these scripts declare top-level names (LOCAL_HOSTS, main) and
// would otherwise collide with each other in a shared global scope.
export {}

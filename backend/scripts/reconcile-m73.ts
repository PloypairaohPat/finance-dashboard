// ─────────────────────────────────────────────────────────────────
//  scripts/reconcile-m73.ts — before/after for every money figure (M7.3 task 3)
//
//  READ-ONLY, local database only. For each metric the app shows it reports:
//
//    BEFORE   what the CURRENT service returns today — the real function, not a
//             description of it.
//    MODEL    the same figure rebuilt transaction by transaction from that
//             service's own rule. If MODEL and BEFORE disagree by a cent, the
//             attribution below is not trustworthy and the report says so
//             instead of quietly rounding.
//    AFTER    the same figure computed from the classifier (src/lib/classifier).
//    WHY      the difference, split by the mechanism recorded when each
//             transaction was classified, summing exactly to the difference.
//
//  The template is the $300 income gap: "cash flow says $6,085.20, insights says
//  $5,785.20" is not an answer. "$300.00 of it is one savings transfer that cash
//  flow counts as income" is.
//
//  Run:
//    cd backend
//    npm run db:guard && npx dotenv -e .env.dev -- tsx scripts/reconcile-m73.ts
//    …add --write to refresh docs/m7.3-reconciliation.md
// ─────────────────────────────────────────────────────────────────

import { writeFileSync } from 'node:fs'
import path from 'node:path'
// Type-only: erased at build time, so it cannot import the app before the guard below runs.
import type { ClassifierTx } from '../src/lib/classifier'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
let host = ''
try {
  host = new URL(process.env.DATABASE_URL ?? '').hostname
} catch {
  /* handled below */
}
if (!LOCAL_HOSTS.has(host)) {
  console.error(`[reconcile] Refusing: DATABASE_URL host "${host || '(unparseable)'}" is not local.`)
  process.exit(1)
}

const DEMO = 'demo-user'
const WRITE = process.argv.includes('--write')

// ── money in integer cents; every total must reconcile exactly ────
const c = (n: number) => Math.round(n * 100)
const m = (cents: number) => cents / 100
const fmt = (cents: number) => {
  const sign = cents < 0 ? '-' : ''
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`
}

interface Contribution {
  key: string
  cents: number
}

interface MetricResult {
  id: string
  title: string
  note: string
  serviceTotals: Map<string, number>
  modelTotals: Map<string, number>
  afterTotals: Map<string, number>
  attribution: Map<string, Map<string, number>> // key -> mechanism -> cents
}

async function main() {
  const { default: prisma } = await import('../src/lib/prisma')
  const { classify, PAYMENTS_TO_PEOPLE } = await import('../src/lib/classifier')
  const { isSpending, mapPlaidCategory } = await import('../src/lib/categoryMap')
  const { filterInternalTransfers } = await import('../src/utils/transferFilter')
  const { getSubscriptionMerchants } = await import('../src/services/subscriptions.service')
  const { plaidClient } = await import('../src/lib/plaidClient')
  const period = await import('../src/lib/period')
  const { fetchInsights } = await import('../src/services/insights.service')
  const { fetchCashFlow } = await import('../src/services/cashflow.service')
  const { fetchMonthlyTotals, fetchCategorySpend } = await import('../src/services/transactions.service')
  const { fetchBudgetsWithSpend } = await import('../src/services/budgets.service')
  const { fetchFirstTransactionDate } = await import('../src/services/activity.service')

  const now = new Date()
  const user = await prisma.user.findUnique({ where: { id: DEMO }, select: { periodStartDay: true } })
  const startDay = user?.periodStartDay ?? 1

  const [accounts, items, rows] = await Promise.all([
    prisma.account.findMany({ where: { userId: DEMO }, select: { id: true, type: true } }),
    prisma.plaidItem.findMany({ where: { userId: DEMO }, select: { institutionName: true, id: true } }),
    prisma.transaction.findMany({
      where: { userId: DEMO, deletedAt: null },
      select: {
        id: true, accountId: true, date: true, amount: true, pending: true,
        categoryPrimary: true, categoryDetailed: true, cleanName: true, name: true, rawJson: true,
      },
      orderBy: { date: 'asc' },
    }),
  ])

  const accountType = new Map(accounts.map((a) => [a.id, a.type]))
  const accountsWithCredit = accounts.filter((a) => a.type === 'credit').map((a) => a.id)
  const itemsWithCredit = await prisma.account.findMany({
    where: { userId: DEMO, id: { in: accountsWithCredit } },
    select: { plaidItem: { select: { institutionName: true } } },
  })

  const tx = rows.map((r) => {
    const raw = (r.rawJson ?? {}) as Record<string, unknown>
    const pfc = (raw.personal_finance_category ?? {}) as Record<string, string>
    return {
      id: r.id,
      accountId: r.accountId,
      accountType: accountType.get(r.accountId) ?? 'depository',
      date: r.date,
      amount: r.amount.toNumber(),
      categoryPrimary: r.categoryPrimary,
      categoryDetailed: r.categoryDetailed,
      confidence: pfc.confidence_level ?? null,
      counterparties: (Array.isArray(raw.counterparties) ? raw.counterparties : []) as Array<{
        name?: string | null
        type?: string | null
      }>,
      pending: r.pending,
      merchantKey: (r.cleanName ?? r.name ?? '').toLowerCase(),
    }
  })

  // ── AFTER: one classification, reused by every metric ───────────
  const classified = classify(tx as ClassifierTx[], {
    linkedInstitutions: items.map((i) => i.institutionName).filter(Boolean) as string[],
    institutionsWithCreditAccount: itemsWithCredit
      .map((a) => a.plaidItem.institutionName)
      .filter(Boolean) as string[],
    periodKeyOf: (d: Date) => period.periodKeyOf(d, startDay),
  })
  const verdict = (id: string) => classified.byId.get(id)!
  const periodOf = (d: Date) => period.periodKeyOf(d, startDay)

  // ── BEFORE-side inputs the current services depend on ───────────
  const userAccountIds = new Set(accounts.map((a) => a.id))
  const linkedNames = items.map((i) => i.institutionName).filter(Boolean) as string[]
  const firstTx = await fetchFirstTransactionDate(DEMO)

  const cashPeriods = period.periodsFromFirstActivity(period.recentPeriods(now, startDay, 6), firstTx)
  const trendPeriods = period.periodsFromFirstActivity(period.recentPeriods(now, startDay, 12), firstTx)
  const [lastPeriod, thisPeriod] = period.recentPeriods(now, startDay, 2)
  void lastPeriod

  const inWindow = (d: Date, startKey: string, endKey: string) =>
    d >= period.fromDateKey(startKey) && d < period.fromDateKey(endKey)

  const inPeriods = (d: Date, ps: typeof cashPeriods) =>
    ps.length > 0 && inWindow(d, ps[0].start, ps[ps.length - 1].end)

  // The transfer filter, exactly as insights and the breakdown call it.
  const forFilter = tx.map((t) => ({
    id: t.id, date: t.date, amount: t.amount, accountId: t.accountId, categoryPrimary: t.categoryPrimary,
  }))
  const thisPeriodTxs = forFilter.filter((t) => inWindow(t.date, thisPeriod.start, thisPeriod.end))
  const { internalIds: internalThisPeriod } = await filterInternalTransfers(
    DEMO, thisPeriodTxs, userAccountIds, linkedNames,
  )

  let subMerchants: Set<string>
  try {
    subMerchants = await getSubscriptionMerchants(DEMO, plaidClient)
  } catch {
    subMerchants = new Set()
  }

  // ── the real services: the authoritative BEFORE ─────────────────
  const [insights, cashflow, trends, budgets, breakdown] = await Promise.all([
    fetchInsights(DEMO, startDay, now),
    fetchCashFlow(DEMO, 6, startDay, now),
    fetchMonthlyTotals(DEMO, 12, startDay, now),
    fetchBudgetsWithSpend(DEMO),
    fetchCategorySpend(DEMO, {
      start: period.fromDateKey(thisPeriod.start),
      end: period.fromDateKey(thisPeriod.end),
    }),
  ])

  // Budgets still use the calendar month, not the money period.
  const budgetMonth = new Date().toISOString().slice(0, 7)
  const budgetStart = new Date(`${budgetMonth}-01T00:00:00.000Z`)
  const budgetEnd = new Date(budgetStart)
  budgetEnd.setUTCMonth(budgetEnd.getUTCMonth() + 1)

  // ── after-side helpers ──────────────────────────────────────────
  /** Payment-app spend is capped per period, so rule-4 rows are handled per period. */
  const cappedPtP = new Map(classified.paymentApp.map((p) => [p.key, c(p.spend)]))

  /** The same cap over an arbitrary window — budgets still run on calendar months. */
  const cappedPtPOver = (inScope: (t: (typeof tx)[number]) => boolean) => {
    let out = 0
    let inflow = 0
    for (const t of tx) {
      if (verdict(t.id).rule !== 4 || !inScope(t)) continue
      if (t.amount > 0) out += c(t.amount)
      else inflow += c(-t.amount)
    }
    return Math.max(0, out - Math.min(out, inflow))
  }

  const afterSpendContribution = (t: (typeof tx)[number]): number | null => {
    const v = verdict(t.id)
    if (v.rule === 4) return null // handled per period
    if (v.kind === 'spend') return c(t.amount)
    if (v.kind === 'refund') return c(t.amount) // negative: nets down
    return 0
  }
  const afterSpendBucket = (t: (typeof tx)[number]): string => {
    const v = verdict(t.id)
    if (v.kind === 'refund') return v.netsAgainst ?? 'Unallocated refunds'
    return v.bucket ?? 'Other'
  }
  const afterIncomeContribution = (t: (typeof tx)[number]) =>
    verdict(t.id).kind === 'income' ? c(-t.amount) : 0

  /** Why a figure changed for this row: the recorded mechanism, or pending. */
  const reasonFor = (t: (typeof tx)[number], beforeExcludesPending: boolean) =>
    beforeExcludesPending && t.pending ? 'pending-now-included' : verdict(t.id).mechanism

  const metrics: MetricResult[] = []

  function buildMetric(
    id: string,
    title: string,
    note: string,
    serviceTotals: Map<string, number>,
    scope: (t: (typeof tx)[number]) => boolean,
    before: (t: (typeof tx)[number]) => Contribution[],
    after: (t: (typeof tx)[number]) => Contribution[],
    beforeExcludesPending: boolean,
    extraAfter?: Array<Contribution & { mechanism: string }>,
    /** For differences caused by the OLD endpoint's own quirks, which the classifier never recorded. */
    reasonOverride?: (t: (typeof tx)[number]) => string | null,
  ) {
    const modelTotals = new Map<string, number>()
    const afterTotals = new Map<string, number>()
    const attribution = new Map<string, Map<string, number>>()
    const bump = (map: Map<string, number>, key: string, cents: number) =>
      map.set(key, (map.get(key) ?? 0) + cents)

    for (const t of tx) {
      if (!scope(t)) continue
      const b = before(t)
      const a = after(t)
      for (const x of b) bump(modelTotals, x.key, x.cents)
      for (const x of a) bump(afterTotals, x.key, x.cents)

      // Attribute per bucket key, so a row moving buckets shows as a pair.
      const keys = new Set([...b.map((x) => x.key), ...a.map((x) => x.key)])
      for (const key of keys) {
        const delta =
          (a.find((x) => x.key === key)?.cents ?? 0) - (b.find((x) => x.key === key)?.cents ?? 0)
        if (delta === 0) continue
        const mech = reasonOverride?.(t) ?? reasonFor(t, beforeExcludesPending)
        const forKey = attribution.get(key) ?? new Map<string, number>()
        forKey.set(mech, (forKey.get(mech) ?? 0) + delta)
        attribution.set(key, forKey)
      }
    }

    for (const extra of extraAfter ?? []) {
      bump(afterTotals, extra.key, extra.cents)
      const forKey = attribution.get(extra.key) ?? new Map<string, number>()
      forKey.set(extra.mechanism, (forKey.get(extra.mechanism) ?? 0) + extra.cents)
      attribution.set(extra.key, forKey)
    }

    metrics.push({ id, title, note, serviceTotals, modelTotals, afterTotals, attribution })
  }

  // ── 1. Cash flow: income per period ─────────────────────────────
  buildMetric(
    'cashflow-income',
    'Cash flow — income per period',
    'Today: every negative amount is income, settled only, no transfer filter.',
    new Map(cashflow.cashflow.map((p) => [p.key, c(p.income)])),
    (t) => inPeriods(t.date, cashPeriods),
    (t) => (!t.pending && t.amount < 0 ? [{ key: periodOf(t.date), cents: c(-t.amount) }] : []),
    (t) => [{ key: periodOf(t.date), cents: afterIncomeContribution(t) }],
    true,
  )

  // ── 2. Cash flow: expenses per period ───────────────────────────
  const ptpExtras: Array<Contribution & { mechanism: string }> = []
  for (const [key, spendCents] of cappedPtP) ptpExtras.push({ key, cents: spendCents, mechanism: 'payment-app-capped' })

  buildMetric(
    'cashflow-expenses',
    'Cash flow — expenses per period',
    'Today: every positive amount is an expense, settled only, no transfer filter, no isSpending test.',
    new Map(cashflow.cashflow.map((p) => [p.key, c(p.expenses)])),
    (t) => inPeriods(t.date, cashPeriods),
    (t) => (!t.pending && t.amount > 0 ? [{ key: periodOf(t.date), cents: c(t.amount) }] : []),
    (t) => {
      const contribution = afterSpendContribution(t)
      return contribution === null ? [] : [{ key: periodOf(t.date), cents: contribution }]
    },
    true,
    ptpExtras.filter((e) => cashPeriods.some((p) => p.key === e.key)),
  )

  // ── 3. Monthly spending (trends) ────────────────────────────────
  buildMetric(
    'trends',
    'Monthly Spending — total per period',
    'Today: every settled positive amount, with no transfer filter and no isSpending test.',
    new Map(trends.map((p) => [p.key, c(p.total)])),
    (t) => inPeriods(t.date, trendPeriods),
    (t) => (!t.pending && t.amount > 0 ? [{ key: periodOf(t.date), cents: c(t.amount) }] : []),
    (t) => {
      const contribution = afterSpendContribution(t)
      return contribution === null ? [] : [{ key: periodOf(t.date), cents: contribution }]
    },
    true,
    ptpExtras.filter((e) => trendPeriods.some((p) => p.key === e.key)),
  )

  // ── 4. Insights: income and expenses, current period ────────────
  buildMetric(
    'insights-income',
    'Monthly summary — income, current period',
    'Today: negative amounts, pending included, minus whatever the two-tier transfer filter catches.',
    new Map([['income', c(insights.summary.income)]]),
    (t) => inWindow(t.date, thisPeriod.start, thisPeriod.end),
    (t) => (t.amount < 0 && !internalThisPeriod.has(t.id) ? [{ key: 'income', cents: c(-t.amount) }] : []),
    (t) => [{ key: 'income', cents: afterIncomeContribution(t) }],
    false,
  )

  buildMetric(
    'insights-expenses',
    'Monthly summary — expenses, current period',
    'Today: positive amounts passing isSpending, pending included, transfer-filtered.',
    new Map([['expenses', c(insights.summary.expenses)]]),
    (t) => inWindow(t.date, thisPeriod.start, thisPeriod.end),
    (t) =>
      t.amount > 0 && isSpending(t.categoryPrimary) && !internalThisPeriod.has(t.id)
        ? [{ key: 'expenses', cents: c(t.amount) }]
        : [],
    (t) => {
      const contribution = afterSpendContribution(t)
      return contribution === null ? [] : [{ key: 'expenses', cents: contribution }]
    },
    false,
    cappedPtP.has(thisPeriod.key)
      ? [{ key: 'expenses', cents: cappedPtP.get(thisPeriod.key)!, mechanism: 'payment-app-capped' }]
      : [],
  )

  // ── 5. Budget cards ─────────────────────────────────────────────
  buildMetric(
    'budgets',
    'Budget cards — spend per category, current calendar month',
    'Today: settled positive amounts by display category, no transfer filter. Still calendar months, not money periods.',
    new Map(budgets.map((b) => [b.category, c(b.currentSpend)])),
    (t) => t.date >= budgetStart && t.date < budgetEnd,
    (t) =>
      !t.pending && t.amount > 0
        ? [{ key: mapPlaidCategory(t.categoryPrimary), cents: c(t.amount) }]
        : [],
    (t) => {
      const contribution = afterSpendContribution(t)
      if (contribution === null) return []
      return contribution === 0 ? [] : [{ key: afterSpendBucket(t), cents: contribution }]
    },
    true,
    [
      {
        key: PAYMENTS_TO_PEOPLE,
        cents: cappedPtPOver((t) => t.date >= budgetStart && t.date < budgetEnd),
        mechanism: 'payment-app-capped',
      },
    ],
  )

  // ── 6. Spending breakdown, current period ───────────────────────
  buildMetric(
    'breakdown',
    'Spending breakdown — category, current period',
    'Today: positive non-internal amounts passing isSpending, pending included, with subscription merchants moved to their own bucket.',
    new Map(breakdown.map((b) => [b.category, c(b.amount)])),
    (t) => inWindow(t.date, thisPeriod.start, thisPeriod.end),
    (t) => {
      if (!(t.amount > 0) || internalThisPeriod.has(t.id) || !isSpending(t.categoryPrimary)) return []
      const bucket = subMerchants.has(t.merchantKey) ? 'Subscriptions' : mapPlaidCategory(t.categoryPrimary)
      return [{ key: bucket, cents: c(t.amount) }]
    },
    (t) => {
      const contribution = afterSpendContribution(t)
      if (contribution === null) return []
      return contribution === 0 ? [] : [{ key: afterSpendBucket(t), cents: contribution }]
    },
    false,
    cappedPtP.has(thisPeriod.key)
      ? [{ key: PAYMENTS_TO_PEOPLE, cents: cappedPtP.get(thisPeriod.key)!, mechanism: 'payment-app-capped' }]
      : [],
    // The breakdown moves anything Plaid calls recurring into a "Subscriptions"
    // bucket. That is the old endpoint's doing, not the classifier's, so say so
    // rather than labelling the move with the classifier's verdict.
    (t) => (subMerchants.has(t.merchantKey) ? 'subscription-override-dropped' : null),
  )

  // ── report ──────────────────────────────────────────────────────
  const out: string[] = []
  const p = (s = '') => out.push(s)

  p('# M7.3 — before / after, with every difference attributed')
  p()
  p(`Generated by \`scripts/reconcile-m73.ts\` against the **demo seed** in the local dev`)
  p(`database on ${now.toISOString().slice(0, 10)}. Period start day: ${startDay}.`)
  p()
  p('**BEFORE** is the current service, called for real. **MODEL** is that same figure')
  p('rebuilt transaction by transaction from the service\'s own rule — it exists only to')
  p('prove the attribution is complete, and any disagreement with BEFORE is reported as a')
  p('failure rather than smoothed over. **AFTER** is the classifier.')
  p()

  let allFaithful = true
  let allReconciled = true

  p('## Faithfulness of the models')
  p()
  p('Compared key by key, over the keys the service reports. Some services omit keys')
  p('(budget cards only report categories that have a budget), so a total can differ')
  p('while every reported figure matches — the per-key difference is the one that counts.')
  p()
  p('| Metric | Service total | Model, same keys | Per-key difference |')
  p('|---|---:|---:|---:|')
  for (const metric of metrics) {
    const service = [...metric.serviceTotals.values()].reduce((s, v) => s + v, 0)
    let modelSameKeys = 0
    let diff = 0
    for (const [key, value] of metric.serviceTotals) {
      const model = metric.modelTotals.get(key) ?? 0
      modelSameKeys += model
      diff += model - value
    }
    if (diff !== 0) allFaithful = false
    p(`| ${metric.title} | ${fmt(service)} | ${fmt(modelSameKeys)} | ${diff === 0 ? 'none' : fmt(diff)} |`)
  }
  p()

  for (const metric of metrics) {
    p(`## ${metric.title}`)
    p()
    p(`*${metric.note}*`)
    p()
    p('| | Before | After | Change | Why |')
    p('|---|---:|---:|---:|---|')
    const keys = new Set([
      ...metric.serviceTotals.keys(),
      ...metric.modelTotals.keys(),
      ...metric.afterTotals.keys(),
    ])
    for (const key of [...keys].sort()) {
      // BEFORE is the model, which the table above proves equals the service on
      // every key the service reports. Using it keeps "Why" summing exactly to
      // "Change" even where the service omits the key entirely.
      const before = metric.modelTotals.get(key) ?? 0
      const after = metric.afterTotals.get(key) ?? 0
      const delta = after - before
      const reasons = metric.attribution.get(key) ?? new Map<string, number>()
      const attributed = [...reasons.values()].reduce((s, v) => s + v, 0)
      const residual = delta - attributed
      if (residual !== 0) allReconciled = false
      const why = [...reasons.entries()]
        .filter(([, v]) => v !== 0)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .map(([mech, v]) => `${mech} ${fmt(v)}`)
        .join('; ')
      const unreported = !metric.serviceTotals.has(key) ? ' †' : ''
      p(
        `| ${key}${unreported} | ${fmt(before)} | ${fmt(after)} | ${delta === 0 ? '—' : fmt(delta)} | ${
          why || '—'
        }${residual !== 0 ? ` · **UNEXPLAINED ${fmt(residual)}**` : ''} |`,
      )
    }
    if ([...keys].some((k) => !metric.serviceTotals.has(k))) {
      p()
      p('† the current endpoint does not report this line at all.')
    }
    p()
  }

  // ── the headline: one figure, two endpoints, now agreeing ───────
  const cashflowIncomeBefore = c(
    cashflow.cashflow.find((x) => x.key === thisPeriod.key)?.income ?? 0,
  )
  const insightsIncomeBefore = c(insights.summary.income)
  const incomeAfter = metrics.find((x) => x.id === 'insights-income')!.afterTotals.get('income') ?? 0
  const cashflowIncomeAfter =
    metrics.find((x) => x.id === 'cashflow-income')!.afterTotals.get(thisPeriod.key) ?? 0

  p('## The same figure, from two endpoints')
  p()
  p(`For the current period (${thisPeriod.label}), "income" is computed twice today and`)
  p('disagrees, which is the disagreement plan §7 recorded:')
  p()
  p('| | Cash flow | Monthly summary | Gap |')
  p('|---|---:|---:|---:|')
  p(
    `| Before | ${fmt(cashflowIncomeBefore)} | ${fmt(insightsIncomeBefore)} | ${fmt(
      cashflowIncomeBefore - insightsIncomeBefore,
    )} |`,
  )
  p(`| After | ${fmt(cashflowIncomeAfter)} | ${fmt(incomeAfter)} | ${fmt(cashflowIncomeAfter - incomeAfter)} |`)
  p()
  const gapReasons = metrics.find((x) => x.id === 'cashflow-income')!.attribution.get(thisPeriod.key)
  const insightsReasons = metrics.find((x) => x.id === 'insights-income')!.attribution.get('income')
  const onlyInCashflow = new Map(gapReasons ?? [])
  for (const [mech, v] of insightsReasons ?? []) {
    const current = onlyInCashflow.get(mech) ?? 0
    if (current === v) onlyInCashflow.delete(mech)
    else onlyInCashflow.set(mech, current - v)
  }
  p('The gap was never mysterious once each side is attributed. Cash flow counted things')
  p('the monthly summary already excluded:')
  p()
  for (const [mech, v] of [...onlyInCashflow].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))) {
    p(`- **${mech}** — ${fmt(-v)} counted by cash flow and not by the summary`)
  }
  p()
  p('Both now come from the same rules, so they agree by construction rather than by luck.')
  p()

  p('## Checks')
  p()
  p(`- Every model reproduces its service exactly: **${allFaithful ? 'yes' : 'NO'}**`)
  p(`- Every change is fully attributed, to the cent: **${allReconciled ? 'yes' : 'NO'}**`)
  p()

  const report = out.join('\n')
  console.log(report)

  if (WRITE) {
    const target = path.resolve(__dirname, '..', '..', 'docs', 'm7.3-reconciliation.md')
    writeFileSync(target, `${report}\n`, 'utf8')
    console.error(`\n[reconcile] wrote ${target}`)
  }
  if (!allFaithful || !allReconciled) {
    console.error('\n[reconcile] FAILED: a model did not reproduce its service, or a change is unexplained.')
    process.exitCode = 1
  }

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('[reconcile] failed:', err)
  process.exit(1)
})

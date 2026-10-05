// ─────────────────────────────────────────────────────────────────
//  rent-and-pay-audit — one user's rent payment and pay, for a decision.
//  READ-ONLY. No amounts, dates, names or ids are printed:
//    - every outflow is shown as a MULTIPLE of the D1 transfer it follows
//      (1.00× = the same size as that transfer), so "is a full rent payment
//      being counted?" can be answered without a figure;
//    - days are relative to that transfer; periods are relative (0 = current);
//    - payees and income sources are lettered (payee A, source A).
//
//  6. Rent. For each same-day transfer D1 paired (mechanism
//     internal-transfer-same-day), the largest outflows from linked accounts in
//     the 7 days after it, then the largest anywhere in that money period, each
//     with its verdict, mechanism, whether it counts as spending, and bucket.
//     Then the period's spend and payment-app flows, as multiples of the
//     transfer. Which of these explains a spend smaller than one rent:
//       - netted under R4 against payment-app repayments (her share only);
//       - paid from an account Ledger can't see (no outflow of that size);
//       - a smaller amount than the transfer;
//       - an outflow of that size that is NOT counted as spending (a bug, in
//         the flattering direction).
//
//  7. Pay. Every transfer-in the classifier counts as income, grouped by source:
//     counterparty type, whether it names a linked bank, pay-like versus
//     transfer-like wording, deposits per month, the gaps between deposits, and
//     how much the amounts vary.
//
//    railway run npx tsx scripts/rent-and-pay-audit.ts --user <id> --allow-remote <db host>
// ─────────────────────────────────────────────────────────────────

import { connectReadOnly, flag, makeRefuse, redact } from './lib/read-only-db'

const SCRIPT = 'rent-and-pay-audit'
const refuse: (message: string) => never = makeRefuse(SCRIPT)
const DAY_MS = 86_400_000
const PAYLIKE = /\b(payroll|direct\s*dep|dir\s*dep|salary|paycheck|wages?|ppd|ach\s*credit|deposit)\b/i
const TRANSFERLIKE = /\b(transfer|xfer|trnsfr|from\s+savings|from\s+checking|online|share|zelle|venmo)\b/i

/** Copied from subscriptions.service.ts, where it is module-private. */
function normalizeMerchant(raw: string): string {
  let cleaned = raw
    .replace(/\b(help|pay|payments?|www|http|https)\b/gi, '')
    .replace(/\.com\b|\.net\b|\.org\b|\.io\b/gi, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
  const n = cleaned.length
  for (let l = 2; l <= Math.floor(n / 2); l++) {
    if (n % l === 0 && cleaned.slice(0, l).repeat(n / l) === cleaned) return cleaned.slice(0, l)
  }
  return cleaned
}

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

/** Stable letters for anonymised names, in order of first appearance. */
function letterer(prefix: string) {
  const seen = new Map<string, string>()
  return (key: string) => {
    if (!seen.has(key)) {
      const i = seen.size
      seen.set(key, `${prefix} ${i < 26 ? String.fromCharCode(65 + i) : `#${i + 1}`}`)
    }
    return seen.get(key)!
  }
}

const x = (n: number) => `${n.toFixed(2)}×`

async function main() {
  const userId = flag('user')
  if (!userId || userId.startsWith('--')) refuse('--user <id> is required.')

  const db = await connectReadOnly(SCRIPT)
  const { classifyWindow, spendForPeriod, paymentAppFlowsForRows } = await import('../src/services/classification.service')
  const { getPeriodStartDay } = await import('../src/services/user.service')
  const { periodKeyOf, recentPeriods } = await import('../src/lib/period')

  const user = await db.prisma.user.findUnique({ where: { id: userId }, select: { paymentAppInflowsAreIncome: true } })
  if (!user) refuse(`no user "${userId}" in this database.`)

  const rows = await db.prisma.transaction.findMany({
    where: { userId, deletedAt: null },
    select: { id: true, date: true, amount: true, name: true, cleanName: true, rawJson: true, categoryDetailed: true },
    orderBy: { date: 'asc' },
  })
  if (rows.length === 0) refuse('this user has no transactions.')
  const startDay = await getPeriodStartDay(userId)
  const now = new Date()
  const { rows: classified, paymentAppByPeriod } = await classifyWindow(userId, {
    since: rows[0].date, until: new Date(now.getTime() + DAY_MS), startDay,
  })
  const byId = new Map(classified.map((c) => [c.id, c]))
  const raw = new Map(rows.map((r) => [r.id, (r.rawJson ?? {}) as Record<string, any>]))
  const label = (id: string) => {
    const r = rows.find((t) => t.id === id)!
    return normalizeMerchant(r.cleanName ?? r.name ?? '')
  }

  // Periods, relative: 0 is the current one.
  const periodIndex = new Map(recentPeriods(now, startDay, 24).reverse().map((p, i) => [p.key, i]))
  const rel = (d: Date) => {
    const i = periodIndex.get(periodKeyOf(d, startDay))
    return i === undefined ? 'older' : String(-i)
  }

  console.log(`\n${SCRIPT} — ${userId.slice(0, 12)}… on ${db.host} (${db.envName}, read-only)`)
  console.log(`payment-app setting: ${user.paymentAppInflowsAreIncome ? 'ON (inflows are income)' : 'off (inflows net against payments out)'}; money periods start on day ${startDay}\n`)

  // ── 6. the rent payment ────────────────────────────────────────
  const payee = letterer('payee')
  const anchors = classified.filter((c) => c.verdict.mechanism === 'internal-transfer-same-day' && c.amount > 0)
  console.log(`6. Same-day transfers D1 paired: ${anchors.length}\n`)

  const describe = (c: (typeof classified)[number], anchor: (typeof classified)[number]) => ({
    payee: payee(label(c.id)),
    days_after: Math.round((c.date.getTime() - anchor.date.getTime()) / DAY_MS),
    size: x(c.amount / anchor.amount),
    verdict: c.verdict.kind,
    mechanism: c.verdict.mechanism,
    counts_as_spend: c.verdict.kind === 'spend' ? 'yes' : 'NO',
    bucket: c.verdict.bucket ?? (c.verdict.kind === 'refund' ? `nets ${c.verdict.netsAgainst ?? 'unallocated'}` : '—'),
  })

  for (const [n, anchor] of anchors.entries()) {
    const pairIds = new Set([anchor.id, anchor.verdict.partnerId])
    const outs = classified.filter((c) => c.amount > 0 && !pairIds.has(c.id))
    const week = outs
      .filter((c) => c.date >= anchor.date && c.date.getTime() <= anchor.date.getTime() + 7 * DAY_MS)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 6)
    const key = periodKeyOf(anchor.date, startDay)
    const period = outs.filter((c) => periodKeyOf(c.date, startDay) === key).sort((a, b) => b.amount - a.amount).slice(0, 4)

    console.log(`── D1 transfer ${n + 1} of ${anchors.length} (period ${rel(anchor.date)}) — sizes below are multiples of it ──\n`)
    table('   Largest outflows in the 7 days after it:', week.map((c) => describe(c, anchor)))
    table('   Largest outflows anywhere in that money period:', period.map((c) => describe(c, anchor)))

    const inPeriod = classified.filter((c) => periodKeyOf(c.date, startDay) === key)
    const flows = paymentAppFlowsForRows(inPeriod)
    table('   That period, as multiples of the transfer:', [{
      spend: x(spendForPeriod(classified, key, startDay, paymentAppByPeriod) / anchor.amount),
      payment_app_out: x(flows.out / anchor.amount),
      payment_app_in: x(flows.in / anchor.amount),
      payments_to_people_after_cap: x((paymentAppByPeriod.get(key) ?? 0) / anchor.amount),
      outflows_at_least_0_8x_counted_as_spend: inPeriod.filter((c) => c.amount >= 0.8 * anchor.amount && c.verdict.kind === 'spend' && !pairIds.has(c.id)).length,
      outflows_at_least_0_8x_NOT_counted: inPeriod.filter((c) => c.amount >= 0.8 * anchor.amount && c.verdict.kind !== 'spend' && !pairIds.has(c.id)).length,
    }])
  }

  // ── 7. her pay ────────────────────────────────────────────────
  const source = letterer('source')
  const incomeTransfers = classified.filter((c) =>
    c.verdict.kind === 'income' && (c.categoryDetailed ?? '').toUpperCase().startsWith('TRANSFER_IN'))
  const linkedNames = (await db.prisma.plaidItem.findMany({ where: { userId }, select: { institutionName: true } }))
    .map((i) => normalizeMerchant(i.institutionName ?? '')).filter(Boolean)

  const groups = new Map<string, typeof incomeTransfers>()
  for (const c of incomeTransfers) {
    const cps: Array<Record<string, any>> = Array.isArray(raw.get(c.id)?.counterparties) ? raw.get(c.id)!.counterparties : []
    const cp = cps.find((p) => p.entity_id) ?? cps[0]
    const k = cp?.entity_id ?? (cp?.name ? `cp:${normalizeMerchant(cp.name)}` : `label:${label(c.id)}`)
    groups.set(k, [...(groups.get(k) ?? []), c])
  }

  console.log(`7. Transfer-ins the classifier counts as income: ${incomeTransfers.length}\n`)
  table('   By source:', [...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([k, list]) => {
    const cps = list.flatMap((c) => (Array.isArray(raw.get(c.id)?.counterparties) ? raw.get(c.id)!.counterparties : []) as Array<Record<string, any>>)
    const days = list.map((c) => Math.floor(c.date.getTime() / DAY_MS)).sort((a, b) => a - b)
    const gaps = days.slice(1).map((d, i) => d - days[i])
    const amounts = list.map((c) => -c.amount)
    const mean = amounts.reduce((s, a) => s + a, 0) / amounts.length
    const cv = amounts.length > 1 ? Math.sqrt(amounts.reduce((s, a) => s + (a - mean) ** 2, 0) / amounts.length) / mean : 0
    const text = (c: (typeof list)[number]) => {
      const r = rows.find((t) => t.id === c.id)!
      return `${r.name ?? ''} ${raw.get(c.id)?.original_description ?? ''}`
    }
    return {
      source: source(k),
      deposits: list.length,
      codes: [...new Set(list.map((c) => (c.categoryDetailed ?? '').toUpperCase()))].join(' '),
      counterparty_types: [...new Set(cps.map((p) => p.type ?? '?'))].join(' ') || 'none',
      names_a_linked_bank: cps.some((p) => p.type === 'financial_institution' && linkedNames.includes(normalizeMerchant(p.name ?? ''))) ? 'YES' : 'no',
      paylike_text: list.filter((c) => PAYLIKE.test(text(c))).length,
      transferlike_text: list.filter((c) => TRANSFERLIKE.test(text(c))).length,
      per_period: [...new Set(list.map((c) => rel(c.date)))].map((p) => `${p}:${list.filter((c) => rel(c.date) === p).length}`).join(' '),
      gaps_days: gaps.join(' ') || '—',
      amount_variation: amounts.length > 1 ? `${(cv * 100).toFixed(0)}%` : '—',
    }
  }))

  await db.prisma.$disconnect()
}

main().catch((e) => {
  console.error(redact(String(e?.stack ?? e)))
  process.exit(1)
})

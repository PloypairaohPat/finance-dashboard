// ─────────────────────────────────────────────────────────────────
//  recurring-streams-audit — what Plaid's Recurring Transactions would give
//  us, set against what our own detector finds today. M7.6 Stage 0.
//
//  READ-ONLY, and stores nothing. For each non-demo Item it calls
//  /transactions/recurring/get ONCE. Our database is read on the read-only
//  connection (scripts/lib/read-only-db.ts); the detector side runs the same
//  code GET /subscriptions uses for its stored streams
//  (analyseWithDetector), which only reads.
//
//  Counts only. Users and Items appear as "user N" and "item N"; no names,
//  amounts, ids or dates are printed: categories appear as Plaid's codes only.
//  Plaid errors are printed by error code.
//
//  Per user: streams by status, frequency, is_active and category; inflows by
//  detailed category code; each stream bucketed by our classifier's verdict on
//  its transactions (all spend / all transfer / all income / mixed); outflows
//  matched against the detector; inflows that look like regular income.
//
//  It decrypts Plaid access tokens, so it runs through Railway:
//    railway run npx tsx scripts/recurring-streams-audit.ts --allow-remote <db host>
//
//  Each call is a billable request if Recurring Transactions is enabled, and a
//  refused one (INVALID_PRODUCT / ADDITIONAL_CONSENT_REQUIRED) if it isn't —
//  which is itself the first finding.
// ─────────────────────────────────────────────────────────────────

import { connectReadOnly, redact } from './lib/read-only-db'

const DEMO_USER_IDS = new Set(['demo-user'])
const REGULAR_FREQUENCIES = new Set(['WEEKLY', 'BIWEEKLY', 'SEMI_MONTHLY', 'MONTHLY'])

type Counter = Map<string, number>
const bump = (m: Counter, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n)
const show = (title: string, m: Counter) => {
  const rows = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  console.log(`  ${title}: ${rows.length === 0 ? '(none)' : rows.map(([k, n]) => `${k} ${n}`).join(' | ')}`)
}

async function main() {
  const db = await connectReadOnly('recurring-streams-audit')
  console.log(`\nReading ${db.database} on ${db.host} via ${db.envName} — read-only (${db.writeRefusedWith}).`)
  console.log('One /transactions/recurring/get per Item; nothing stored. Counts only.\n')

  // Loaded after connectReadOnly so they use the connection it set up.
  const { decrypt } = await import('../src/utils/encrypt')
  const { plaidClient } = await import('../src/lib/plaidClient')
  const { merchantIdentity } = await import('../src/lib/merchantIdentity')
  const { analyseWithDetector } = await import('../src/services/subscriptions.service')
  const { classifyWindow } = await import('../src/services/classification.service')
  const { getPeriodStartDay } = await import('../src/services/user.service')

  const users = await db.prisma.user.findMany({
    where: { plaidItems: { some: {} } },
    select: { id: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const real = users.filter((u) => !DEMO_USER_IDS.has(u.id))
  console.log(`${real.length} non-demo user(s) with Items.\n`)

  // Totals across everyone, as well as per user.
  const errorsTotal: Counter = new Map()
  let itemNo = 0

  for (const [ui, { id: userId }] of real.entries()) {
    console.log(`════ user ${ui + 1} ════`)
    const items = await db.prisma.plaidItem.findMany({
      where: { userId },
      select: { accessToken: true, accounts: { select: { plaidAccountId: true } } },
      orderBy: { createdAt: 'asc' },
    })

    const inflow: Array<Record<string, any>> = []
    const outflow: Array<Record<string, any>> = []
    let predictedNextDatePresent = 0
    for (const item of items) {
      const label = `item ${++itemNo}`
      try {
        const res = await plaidClient.transactionsRecurringGet({
          access_token: decrypt(item.accessToken),
          ...(item.accounts.length > 0 ? { account_ids: item.accounts.map((a) => a.plaidAccountId) } : {}),
        })
        const data = res.data as any
        inflow.push(...(data.inflow_streams ?? []))
        outflow.push(...(data.outflow_streams ?? []))
        // The installed SDK's type has no predicted_next_date: is it in the JSON?
        for (const s of [...(data.inflow_streams ?? []), ...(data.outflow_streams ?? [])]) {
          if (s && Object.prototype.hasOwnProperty.call(s, 'predicted_next_date')) predictedNextDatePresent++
        }
        console.log(`  ${label}: ok — ${data.inflow_streams?.length ?? 0} inflow, ${data.outflow_streams?.length ?? 0} outflow stream(s)`)
      } catch (err: any) {
        const code = err?.response?.data?.error_code ?? 'NO_PLAID_ERROR_CODE'
        bump(errorsTotal, code)
        console.log(`  ${label}: Plaid error ${code}`)
      }
    }

    if (inflow.length + outflow.length === 0) {
      console.log('  no streams returned\n')
      continue
    }
    console.log(`  streams carrying a predicted_next_date key: ${predictedNextDatePresent} of ${inflow.length + outflow.length}`)

    for (const [name, streams] of [['outflow', outflow], ['inflow', inflow]] as const) {
      const status: Counter = new Map(), freq: Counter = new Map(), active: Counter = new Map(), cat: Counter = new Map()
      for (const s of streams) {
        bump(status, String(s.status))
        bump(freq, String(s.frequency))
        bump(active, s.is_active ? 'active' : 'inactive')
        bump(cat, String(s.personal_finance_category?.primary ?? 'NONE'))
      }
      console.log(`  ${name} streams: ${streams.length}`)
      show('by status', status)
      show('by frequency', freq)
      show('by is_active', active)
      show('by category primary', cat)
    }
    // Inflows by detailed code: tells salary from interest, dividends, transfers.
    const detailed: Counter = new Map()
    for (const s of inflow) bump(detailed, String(s.personal_finance_category?.detailed ?? 'NONE'))
    show('inflow streams by detailed category', detailed)

    // ── our classifier's verdict on each stream's transactions ────
    // A stream is "all spend", "all transfer", "all income", "mixed", or
    // "unmatched" (none of its transactions found in our rows).
    const allIds = [...new Set([...inflow, ...outflow].flatMap((s) => s.transaction_ids ?? []))]
    const streamRows = await db.prisma.transaction.findMany({
      where: { userId, plaidTransactionId: { in: allIds } },
      select: { id: true, plaidTransactionId: true, date: true },
    })
    const rowOf = new Map(streamRows.map((r) => [r.plaidTransactionId, r]))
    const verdictOf = new Map<string, string>()
    if (streamRows.length > 0) {
      const since = new Date(Math.min(...streamRows.map((r) => r.date.getTime())))
      const { rows: classified } = await classifyWindow(userId, {
        since, until: new Date(Date.now() + 86_400_000), startDay: await getPeriodStartDay(userId),
      })
      for (const c of classified) verdictOf.set(c.id, c.verdict.kind)
    }
    const classOf = (kind: string | undefined) =>
      kind === 'spend' ? 'spend'
        : kind === 'income' ? 'income'
          : kind === 'internal_transfer' || kind === 'card_payment' || kind === 'savings_transfer' ? 'transfer'
            : kind === undefined ? 'unclassified' : 'other'
    for (const [name, streams] of [['outflow', outflow], ['inflow', inflow]] as const) {
      const byVerdict: Counter = new Map()
      for (const s of streams) {
        const classes = new Set(
          (s.transaction_ids ?? [])
            .map((t: string) => rowOf.get(t))
            .filter(Boolean)
            .map((r: { id: string }) => classOf(verdictOf.get(r.id))),
        )
        const verdict = classes.size === 0 ? 'unmatched' : classes.size === 1 ? `all ${[...classes][0]}` : 'mixed'
        bump(byVerdict, `${verdict} / ${s.personal_finance_category?.primary ?? 'NONE'}`)
      }
      show(`${name} streams by our verdict on their transactions / Plaid category primary`, byVerdict)
    }

    // ── outflows against the detector ─────────────────────────────
    // Plaid's transaction ids → our rows → their merchantIdentity.
    const plaidIds = [...new Set(outflow.flatMap((s) => s.transaction_ids ?? []))]
    const rows = await db.prisma.transaction.findMany({
      where: { userId, plaidTransactionId: { in: plaidIds } },
      select: { id: true, plaidTransactionId: true, merchantEntityId: true, counterpartyEntities: true, cleanName: true, name: true },
    })
    const byPlaidId = new Map(rows.map((r) => [r.plaidTransactionId, r]))
    const analysis = await analyseWithDetector(userId)
    const detected = [...analysis.subscriptions, ...analysis.bills]
    const detectedByTx = new Map<string, number>()
    detected.forEach((d, i) => d.txIds.forEach((t) => detectedByTx.set(t, i)))
    const detectedByKey = new Map<string, number>()
    detected.forEach((d, i) => detectedByKey.set(d.key, i))

    const matchedDetected = new Set<number>()
    const matched: Counter = new Map(), streamOnly: Counter = new Map(), detectorOnly: Counter = new Map()
    let unmatchedRows = 0
    for (const s of outflow) {
      const cat = String(s.personal_finance_category?.primary ?? 'NONE')
      const ours = (s.transaction_ids ?? []).map((t: string) => byPlaidId.get(t)).filter(Boolean) as typeof rows
      unmatchedRows += (s.transaction_ids?.length ?? 0) - ours.length
      // Through shared transactions first, then the same merchant identity.
      let hit = ours.map((r) => detectedByTx.get(r.id)).find((i) => i !== undefined)
      if (hit === undefined) {
        const keys = new Set(ours.map((r) => merchantIdentity({
          merchantEntityId: r.merchantEntityId, counterpartyEntities: r.counterpartyEntities, label: r.cleanName ?? r.name ?? 'Unknown',
        })))
        hit = [...keys].map((k) => detectedByKey.get(k)).find((i) => i !== undefined)
      }
      if (hit !== undefined) { matchedDetected.add(hit); bump(matched, cat) } else bump(streamOnly, cat)
    }
    detected.forEach((d, i) => { if (!matchedDetected.has(i)) bump(detectorOnly, d.category) })
    console.log(`  outflows vs our detector (${detected.length} detected or marked):`)
    show('matched, by Plaid category primary', matched)
    show('Plaid stream only, by Plaid category primary', streamOnly)
    show('detector only, by our display category', detectorOnly)
    console.log(`  stream transactions not found in our rows: ${unmatchedRows}`)

    // ── inflows: regular income or not ────────────────────────────
    let regular = 0, irregular = 0
    for (const s of inflow) {
      const isIncome = s.personal_finance_category?.primary === 'INCOME'
      if (isIncome && s.status === 'MATURE' && REGULAR_FREQUENCIES.has(s.frequency)) regular++
      else irregular++
    }
    console.log(`  inflows: ${regular} look like regular income (INCOME, MATURE, weekly to monthly), ${irregular} don't\n`)
  }

  console.log('Plaid errors across all Items:')
  show('by error code', errorsTotal)
  console.log()
  await db.prisma.$disconnect()
}

main().catch((e) => {
  console.error(redact(String(e?.stack ?? e)))
  process.exit(1)
})

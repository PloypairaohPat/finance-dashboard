// ─────────────────────────────────────────────────────────────────
//  d1-same-day-exposure — what the D1 fix would change, before building it.
//  READ-ONLY. COUNTS ONLY: no amounts, dates, descriptions or ids printed.
//
//  D1 is decided: a same-day, exact-amount pair across a user's own accounts
//  where ONE leg carries a transfer signal is one internal transfer. The
//  proposed rule is narrower than that sentence, because the seed has two
//  wrong-claim fixtures a plain version would break:
//
//    day 0 only · exact amount · depository ↔ depository · different accounts
//    · exactly one leg with a transfer signal · neither leg already paired by
//    R1/R2 · and the UNCODED leg carries NO counterparty at all.
//
//  The last clause is the one that matters. The incident's rent-coded outflow
//  names nobody; a real bill names who it paid (a landlord as merchant, a
//  lender as financial_institution). This measures the rule both with and
//  without that clause, so its cost and value are numbers, not assertions.
//
//  Also measured: whether a reference number shared between the two legs'
//  descriptions is common enough to use as evidence, per institution; and what
//  each user's transaction count includes (live, removed, pending).
//
//  "Transfer signal" is classifier.ts's own hasTransferSignal; current
//  verdicts come from classifyWindow. Nothing is re-derived here.
//
//    railway run npx tsx scripts/d1-same-day-exposure.ts --allow-remote <db host>
// ─────────────────────────────────────────────────────────────────

import { connectReadOnly, redact } from './lib/read-only-db'

const DAY_MS = 86_400_000
const BILLISH = /\b(rent|bill|utilit\w*|electric\w*|water|insur\w*|loan|mortgage|lease|hoa|pmt|payment)\b/i
const TRANSFERISH = /\b(transfer|xfer|trnsfr|share|to savings|from savings|to checking|from checking)\b/i
/** Six or more digits: long enough to skip dates, masks and share ids. */
const refTokens = (s: string) => new Set(s.match(/\d{6,}/g) ?? [])

interface Leg {
  id: string
  accountId: string
  institution: string
  day: number
  cents: number
  pending: boolean
  primary: string
  text: string
  cpCount: number
  signal: boolean
  mechanism: string
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

const countBy = <T>(xs: T[], key: (x: T) => string) =>
  xs.reduce<Record<string, number>>((m, x) => ((m[key(x)] = (m[key(x)] ?? 0) + 1), m), {})

async function main() {
  const db = await connectReadOnly('d1-same-day-exposure')
  console.log(`\nReading ${db.database} on ${db.host} via ${db.envName} — read-only (${db.writeRefusedWith}).`)
  console.log('Counts only.\n')

  const { classifyWindow } = await import('../src/services/classification.service')
  const { getPeriodStartDay } = await import('../src/services/user.service')
  const { hasTransferSignal } = await import('../src/lib/classifier')

  const users = await db.prisma.user.findMany({
    where: { id: { not: 'demo-user' }, transactions: { some: {} } },
    select: { id: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })

  for (const [idx, { id: userId }] of users.entries()) {
    const n = idx + 1
    console.log(`════ user_n ${n} (${userId.slice(0, 12)}…) ════\n`)

    // ── 5. What the transaction count includes ────────────────────
    const all = await db.prisma.transaction.findMany({
      where: { userId },
      select: {
        id: true, accountId: true, date: true, amount: true, pending: true, deletedAt: true,
        categoryPrimary: true, categoryDetailed: true, name: true, rawJson: true,
      },
    })
    const live = all.filter((t) => !t.deletedAt)
    table('What this user\'s rows include:', [{
      all_rows: all.length,
      live: live.length,
      removed: all.length - live.length,
      removed_that_were_pending: all.filter((t) => t.deletedAt && t.pending).length,
      live_pending: live.filter((t) => t.pending).length,
    }])

    // ── current verdicts, from the classifier ─────────────────────
    const accounts = await db.prisma.account.findMany({
      where: { userId },
      select: { id: true, type: true, plaidItem: { select: { institutionName: true } } },
    })
    const acct = new Map(accounts.map((a) => [a.id, a]))
    const linked = (await db.prisma.plaidItem.findMany({ where: { userId }, select: { institutionName: true } }))
      .map((i) => i.institutionName).filter(Boolean) as string[]

    const times = live.map((t) => t.date.getTime())
    const startDay = await getPeriodStartDay(userId)
    const { rows: classified } = await classifyWindow(userId, {
      since: new Date(Math.min(...times) - DAY_MS),
      until: new Date(Math.max(...times) + DAY_MS),
      startDay,
    })
    const mechanism = new Map(classified.map((r) => [r.id, r.verdict.mechanism]))

    const legs: Leg[] = live
      .filter((t) => acct.get(t.accountId)?.type === 'depository')
      .map((t) => {
        const raw = (t.rawJson ?? {}) as Record<string, any>
        const cps = Array.isArray(raw.counterparties) ? raw.counterparties : []
        return {
          id: t.id,
          accountId: t.accountId,
          institution: acct.get(t.accountId)?.plaidItem?.institutionName ?? '(unknown)',
          day: Math.floor(t.date.getTime() / DAY_MS),
          cents: Math.round(Number(t.amount) * 100),
          pending: t.pending,
          primary: (t.categoryPrimary ?? '(none)').toUpperCase(),
          text: `${t.name ?? ''} ${raw.original_description ?? ''}`,
          cpCount: cps.length,
          signal: hasTransferSignal(
            {
              id: t.id, accountId: t.accountId, accountType: 'depository', date: t.date,
              amount: Number(t.amount), categoryPrimary: t.categoryPrimary, categoryDetailed: t.categoryDetailed,
              confidence: null, counterparties: cps, pending: t.pending,
            },
            linked,
          ),
          mechanism: mechanism.get(t.id) ?? '(unclassified)',
        }
      })

    // ── 3. Every day-0 exact-amount cross-account pair ────────────
    const outs = legs.filter((l) => l.cents > 0)
    const ins = legs.filter((l) => l.cents < 0)
    const pairs: Array<{ out: Leg; in: Leg }> = []
    for (const o of outs) {
      for (const i of ins) {
        if (i.day === o.day && i.accountId !== o.accountId && i.cents === -o.cents) pairs.push({ out: o, in: i })
      }
    }
    const signalShape = (p: { out: Leg; in: Leg }) =>
      p.out.signal && p.in.signal ? 'both legs' : p.out.signal ? 'outflow only' : p.in.signal ? 'inflow only' : 'neither'
    const PAIRED = new Set(['internal-transfer-pair', 'internal-transfer-same-day', 'card-payment-pair'])
    const alreadyPaired = (p: { out: Leg; in: Leg }) => PAIRED.has(p.out.mechanism) && PAIRED.has(p.in.mechanism)

    table('Day-0, exact-amount pairs across this user\'s own depository accounts:', Object.entries(countBy(pairs, signalShape))
      .map(([shape, count]) => ({
        transfer_signal_on: shape,
        pairs: count,
        already_paired_today: pairs.filter((p) => signalShape(p) === shape && alreadyPaired(p)).length,
      })))

    const oneLeg = pairs.filter((p) => (p.out.signal !== p.in.signal) && !alreadyPaired(p)
      && !PAIRED.has(p.out.mechanism) && !PAIRED.has(p.in.mechanism))
    const uncoded = (p: { out: Leg; in: Leg }) => (p.out.signal ? p.in : p.out)
    const narrow = oneLeg.filter((p) => uncoded(p).cpCount === 0)

    const describe = (set: Array<{ out: Leg; in: Leg }>) => ({
      pairs: set.length,
      distinct_outflows: new Set(set.map((p) => p.out.id)).size,
      coded_leg_is_inflow: set.filter((p) => p.in.signal).length,
      coded_leg_is_outflow: set.filter((p) => p.out.signal).length,
      uncoded_is_income_coded: set.filter((p) => uncoded(p).primary.startsWith('INCOME')).length,
      uncoded_billish_text: set.filter((p) => BILLISH.test(uncoded(p).text)).length,
      uncoded_transferish_text: set.filter((p) => TRANSFERISH.test(uncoded(p).text)).length,
      shared_ref_6plus_digits: set.filter((p) => [...refTokens(p.out.text)].some((t) => refTokens(p.in.text).has(t))).length,
      any_leg_pending: set.filter((p) => p.out.pending || p.in.pending).length,
    })
    table('Newly excluded by the proposed rule — with and without the no-counterparty clause:', [
      { rule: 'one leg coded, day 0 (broad)', ...describe(oneLeg) },
      { rule: '…and uncoded leg has NO counterparty (proposed)', ...describe(narrow) },
    ])

    table('Uncoded leg\'s Plaid category, proposed rule:',
      Object.entries(countBy(narrow, (p) => uncoded(p).primary)).map(([category, count]) => ({ category, pairs: count })))
    table('…and the pairs the no-counterparty clause refuses (what it protects):',
      Object.entries(countBy(oneLeg.filter((p) => uncoded(p).cpCount > 0), (p) => uncoded(p).primary))
        .map(([category, count]) => ({ category, pairs: count })))

    // ── 4. Is a shared reference number usable as evidence? ───────
    const inst = (p: { out: Leg; in: Leg }) =>
      p.out.institution === p.in.institution ? p.out.institution : `${p.out.institution} → ${p.in.institution}`
    table('Shared 6+-digit reference token between the two legs, all day-0 pairs, by institution:',
      Object.entries(countBy(pairs, inst)).map(([institution]) => {
        const mine = pairs.filter((p) => inst(p) === institution)
        return {
          institution,
          pairs: mine.length,
          share_a_reference: mine.filter((p) => [...refTokens(p.out.text)].some((t) => refTokens(p.in.text).has(t))).length,
          both_legs_already_paired: mine.filter(alreadyPaired).length,
        }
      }))
  }

  await db.prisma.$disconnect()
}

main().catch((e) => {
  console.error(redact(String(e?.stack ?? e)))
  process.exit(1)
})

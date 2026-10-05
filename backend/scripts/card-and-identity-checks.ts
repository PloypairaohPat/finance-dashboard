// ─────────────────────────────────────────────────────────────────
//  card-and-identity-checks — three follow-up questions from the taxonomy
//  audit. READ-ONLY. Counts, Plaid enum values and yes/no only: no amounts,
//  dates, names, institutions or ids.
//
//  A. INCOME_CONTRACTOR inflows the classifier paired as card payments: on a
//     credit account (a miscoded card-side leg — fine) or a depository one
//     (contractor pay paired away — lost income)?
//  B. LOAN_PAYMENTS_CREDIT_CARD_PAYMENT outflows counted as ordinary spend: is
//     the destination card linked (then its purchases are already counted and
//     this double counts), and which of R5's conditions sent it to spend rather
//     than card-payment-unpaired? R5 needs a counterparty naming an institution
//     where a credit account is linked, at HIGH+ confidence; names are compared
//     normalised, so "Card Co" and "Card Co Bank" do NOT match.
//  C. Spend grouped by Plaid entity id: for every entity that subscription
//     detection splits into several merchants, where the id came from
//     (merchant_entity_id or a counterparty's entity_id), what counterparty type
//     carries it, and whether its names even look alike. An entity id on a
//     payment app or marketplace would merge different payees.
//
//    railway run npx tsx scripts/card-and-identity-checks.ts --allow-remote <db host>
// ─────────────────────────────────────────────────────────────────

import { connectReadOnly, redact } from './lib/read-only-db'

const DAY_MS = 86_400_000

/** Copied verbatim from subscriptions.service.ts, where it is module-private. */
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
/** classifier.ts's normalize, used to compare institution names (module-private there). */
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

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

const tally = (xs: string[]) => {
  const m = new Map<string, number>()
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => b[1] - a[1])
}

async function main() {
  const db = await connectReadOnly('card-and-identity-checks')
  console.log(`\nReading ${db.database} on ${db.host} via ${db.envName} — read-only (${db.writeRefusedWith}).`)
  console.log('Counts, Plaid enum values and yes/no only.\n')

  const { classifyWindow } = await import('../src/services/classification.service')
  const { getPeriodStartDay } = await import('../src/services/user.service')

  const users = await db.prisma.user.findMany({
    where: { transactions: { some: {} } },
    select: { id: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })

  for (const [idx, { id: userId }] of users.entries()) {
    console.log(`════ ${userId === 'demo-user' ? 'demo-user' : `user_n ${idx + 1} (${userId.slice(0, 12)}…)`} ════\n`)

    const rows = await db.prisma.transaction.findMany({
      where: { userId, deletedAt: null },
      select: { id: true, date: true, amount: true, accountId: true, categoryDetailed: true, cleanName: true, name: true, rawJson: true },
      orderBy: { date: 'asc' },
    })
    if (rows.length === 0) continue
    const accounts = await db.prisma.account.findMany({
      where: { userId }, select: { id: true, type: true, plaidItem: { select: { institutionName: true } } },
    })
    const acctType = new Map(accounts.map((a) => [a.id, a.type]))
    const linked = new Set(accounts.map((a) => normalize(a.plaidItem?.institutionName ?? '')).filter(Boolean))
    const withCard = new Set(accounts.filter((a) => a.type === 'credit').map((a) => normalize(a.plaidItem?.institutionName ?? '')).filter(Boolean))

    const startDay = await getPeriodStartDay(userId)
    const { rows: classified } = await classifyWindow(userId, {
      since: rows[0].date, until: new Date(Date.now() + DAY_MS), startDay,
    })
    const verdict = new Map(classified.map((c) => [c.id, c.verdict]))
    const byId = new Map(rows.map((r) => [r.id, r]))
    const raw = (r: (typeof rows)[number]) => (r.rawJson ?? {}) as Record<string, any>
    const cps = (r: (typeof rows)[number]): Array<Record<string, any>> =>
      (Array.isArray(raw(r).counterparties) ? raw(r).counterparties : [])
    const code = (r: (typeof rows)[number]) => (r.categoryDetailed ?? '').toUpperCase()

    // ── A. contractor inflows paired as card payments ─────────────
    const contractor = rows.filter((r) => Number(r.amount) < 0 && code(r) === 'INCOME_CONTRACTOR')
    table('A. INCOME_CONTRACTOR inflows, by the account they landed on and their verdict:',
      tally(contractor.map((r) => {
        const v = verdict.get(r.id)
        const partner = v?.partnerId ? byId.get(v.partnerId) : undefined
        return `${acctType.get(r.accountId) ?? '?'} account → ${v?.kind ?? '?'} (${v?.mechanism ?? '?'})` +
          (partner ? `; partner: ${acctType.get(partner.accountId) ?? '?'} ${code(partner)}` : '')
      })).map(([k, n]) => ({ landed_on_and_verdict: k, rows: n })))

    // ── B. card payments counted as spending ───────────────────────
    const cardPayAsSpend = rows.filter((r) =>
      Number(r.amount) > 0 && code(r) === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' && verdict.get(r.id)?.kind === 'spend')
    console.log(`B. LOAN_PAYMENTS_CREDIT_CARD_PAYMENT outflows counted as spending: ${cardPayAsSpend.length}`)
    console.log(`   This user has a linked credit account: ${withCard.size > 0 ? 'yes' : 'NO'}\n`)
    table('   Why each went to spending (R5 needs: a depository outflow; a counterparty naming an institution with a linked card; HIGH+ confidence):',
      tally(cardPayAsSpend.map((r) => {
        const v = verdict.get(r.id)
        const fis = cps(r).filter((c) => (c.type ?? '').toLowerCase() === 'financial_institution').map((c) => normalize(c.name ?? ''))
        const exactCard = fis.some((n) => withCard.has(n))
        const looseCard = fis.some((n) => [...withCard].some((w) => n && w && (n.includes(w) || w.includes(n))))
        const conf = String(raw(r).personal_finance_category?.confidence_level ?? 'missing')
        // The nearest exact-amount credit-account inflow, so a missed R1 pair shows.
        const cents = Math.round(Number(r.amount) * 100)
        const near = rows
          .filter((o) => acctType.get(o.accountId) === 'credit' && Math.round(Number(o.amount) * 100) === -cents)
          .map((o) => ({ o, gap: Math.round(Math.abs(o.date.getTime() - r.date.getTime()) / DAY_MS) }))
          .sort((a, b) => a.gap - b.gap)[0]
        return [
          `on ${acctType.get(r.accountId) ?? '?'}`,
          `rule R${v?.rule}`,
          `counterparty types: ${cps(r).map((c) => c.type ?? '?').join('+') || 'none'}`,
          `names a linked bank: ${fis.some((n) => linked.has(n)) ? 'yes' : 'no'}`,
          `names a bank with a linked card — exact: ${exactCard ? 'yes' : 'no'}, loose: ${looseCard ? 'yes' : 'no'}`,
          `confidence ${conf}`,
          `exact-amount card-side inflow: ${near ? `${near.gap}d away, ${verdict.get(near.o.id)?.mechanism}` : 'none'}`,
        ].join(' | ')
      })).map(([k, n]) => ({ explanation: k, rows: n })))

    // ── C. entity ids that subscription detection splits ─────────
    const spend = rows.filter((r) => verdict.get(r.id)?.kind === 'spend')
    type Ent = { names: Set<string>; rows: number; sources: Set<string>; types: Set<string>; mechs: Set<string>; primaries: Set<string> }
    const ents = new Map<string, Ent>()
    for (const r of spend) {
      const mid = raw(r).merchant_entity_id as string | undefined
      const cp = cps(r).find((c) => c.entity_id)
      const id = mid ?? cp?.entity_id
      if (!id) continue
      const e = ents.get(id) ?? { names: new Set(), rows: 0, sources: new Set(), types: new Set(), mechs: new Set(), primaries: new Set() }
      e.names.add(normalizeMerchant(r.cleanName ?? r.name ?? ''))
      e.rows++
      e.sources.add(mid ? 'merchant_entity_id' : 'counterparty entity_id')
      // The type of the counterparty that carries this entity id.
      const carrier = cps(r).find((c) => c.entity_id === id)
      e.types.add(carrier?.type ?? (mid ? '(no counterparty with that id)' : '?'))
      e.mechs.add(verdict.get(r.id)?.mechanism ?? '?')
      e.primaries.add((raw(r).personal_finance_category?.primary ?? '?').toUpperCase())
      ents.set(id, e)
    }
    /** Whether the names share a stem: the shortest name's first five characters appear in all. */
    const alike = (names: Set<string>) => {
      const list = [...names].filter(Boolean).sort((a, b) => a.length - b.length)
      if (list.length < 2) return 'n/a'
      const stem = list[0].slice(0, 5)
      return stem.length >= 3 && list.every((n) => n.includes(stem)) ? 'yes' : 'no'
    }
    const split = [...ents.values()].filter((e) => e.names.size > 1).sort((a, b) => b.names.size - a.names.size)
    console.log(`C. Spend rows with an entity id: ${spend.filter((r) => raw(r).merchant_entity_id || cps(r).some((c) => c.entity_id)).length} of ${spend.length}; entities: ${ents.size}; split by subscription detection: ${split.length}\n`)
    table('   Each split entity (largest first):', split.map((e, i) => ({
      entity: `entity ${i + 1}`,
      names: e.names.size,
      rows: e.rows,
      id_from: [...e.sources].join(' + '),
      carried_by_counterparty_type: [...e.types].join(' + '),
      names_look_alike: alike(e.names),
      mechanisms: [...e.mechs].join(' + '),
      distinct_primary_codes: e.primaries.size,
    })))
    table('   Split entities by the counterparty type that carries the id:',
      tally(split.map((e) => [...e.types].join(' + '))).map(([type, n]) => ({
        type, entities: n,
        names_merged: split.filter((e) => [...e.types].join(' + ') === type).reduce((s, e) => s + e.names.size, 0),
      })))
  }

  await db.prisma.$disconnect()
}

main().catch((e) => {
  console.error(redact(String(e?.stack ?? e)))
  process.exit(1)
})

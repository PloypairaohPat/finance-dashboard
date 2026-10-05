// ─────────────────────────────────────────────────────────────────
//  taxonomy-audit — which Plaid category codes and payer identities our data
//  actually has, against what the code is keyed on. READ-ONLY.
//  Prints counts and Plaid enum codes only: no amounts, dates, merchant or
//  payer names, or ids. Payers are anonymised (payer A, B…), periods are
//  relative (period 0 is the current one).
//
//  Per user:
//    1. Taxonomy evidence: the version field Plaid stamps on each category, if
//       any, and whether codes that exist only in PFCv2 are present.
//    2. Every distinct (direction, primary, detailed) on live rows, with counts
//       and the classifier mechanism each lands in. Then every detailed code
//       src/ references that never appears.
//    3. R7's savings branch: where transfers OUT land when their other leg
//       isn't in Ledger, and, for those counted as spending, their share of
//       spend per period.
//    4. Payer identity: salary and contractor deposits grouped under each key
//       we have — the old one (the label), the label normalised the way
//       subscription detection does it, Plaid's merchant_name, and the entity
//       ids Plaid sends — with how many rows carry each field. Then the same for
//       recurring spend: how many distinct labels each entity id collapses.
//
//  Classifier verdicts come from classifyWindow; nothing here re-derives a rule.
//
//    railway run npx tsx scripts/taxonomy-audit.ts --allow-remote <db host>
// ─────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { connectReadOnly, redact } from './lib/read-only-db'

const DAY_MS = 86_400_000

// PFCv2 primaries (a superset of v1's). Plaid enum constants.
const PRIMARIES = [
  'INCOME', 'LOAN_DISBURSEMENTS', 'TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS', 'BANK_FEES', 'ENTERTAINMENT',
  'FOOD_AND_DRINK', 'GENERAL_MERCHANDISE', 'GENERAL_SERVICES', 'GOVERNMENT_AND_NON_PROFIT', 'HOME_IMPROVEMENT',
  'MEDICAL', 'PERSONAL_CARE', 'RENT_AND_UTILITIES', 'TRANSPORTATION', 'TRAVEL', 'OTHER',
].sort((a, b) => b.length - a.length)
/** Codes that exist only in PFCv2: their presence proves which taxonomy an Item returns. */
const V2_ONLY = ['INCOME_SALARY', 'INCOME_CONTRACTOR', 'OTHER_OTHER', 'TRANSFER_IN_TRANSFER_IN_FROM_APPS', 'TRANSFER_OUT_TRANSFER_OUT_FROM_APPS']
const SALARY = ['INCOME_SALARY', 'INCOME_WAGES']
const CONTRACTOR = ['INCOME_CONTRACTOR']

/**
 * Copied verbatim from src/services/subscriptions.service.ts, where it is
 * module-private; this branch changes nothing in src/. It is the key
 * subscription detection groups merchants by.
 */
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

/** Every detailed code src/ references, read from the source files. */
function codesReferencedInSrc(): Set<string> {
  const files = ['src/lib/classifier.ts', 'src/lib/categoryMap.ts', 'src/services/subscriptions.service.ts', 'src/services/transactions.service.ts']
  const tok = /\b[A-Z][A-Z]+(?:_[A-Z]+)+\b/g
  const out = new Set<string>()
  for (const f of files) {
    for (const t of readFileSync(path.resolve(__dirname, '..', f), 'utf8').match(tok) ?? []) {
      if (PRIMARIES.some((p) => t.startsWith(`${p}_`)) && !PRIMARIES.includes(t)) out.add(t)
    }
  }
  return out
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

const tally = (xs: string[]) => {
  const m = new Map<string, number>()
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => b[1] - a[1])
}
const fmtTally = (xs: string[]) => tally(xs).map(([k, n]) => `${k} ${n}`).join(', ')

async function main() {
  const db = await connectReadOnly('taxonomy-audit')
  console.log(`\nReading ${db.database} on ${db.host} via ${db.envName} — read-only (${db.writeRefusedWith}).`)
  console.log('Counts and Plaid enum codes only.\n')

  const { classifyWindow, spendForPeriod } = await import('../src/services/classification.service')
  const { getPeriodStartDay } = await import('../src/services/user.service')
  const { recentPeriods, periodKeyOf } = await import('../src/lib/period')
  const referenced = codesReferencedInSrc()

  const users = await db.prisma.user.findMany({
    where: { transactions: { some: {} } },
    select: { id: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })

  for (const [idx, { id: userId }] of users.entries()) {
    console.log(`════ ${userId === 'demo-user' ? 'demo-user' : `user_n ${idx + 1} (${userId.slice(0, 12)}…)`} ════\n`)

    const rows = await db.prisma.transaction.findMany({
      where: { userId, deletedAt: null },
      select: { id: true, date: true, amount: true, categoryPrimary: true, categoryDetailed: true, cleanName: true, name: true, merchantName: true, rawJson: true },
      orderBy: { date: 'asc' },
    })
    if (rows.length === 0) continue
    const startDay = await getPeriodStartDay(userId)
    const now = new Date()
    const { rows: classified, paymentAppByPeriod } = await classifyWindow(userId, {
      since: rows[0].date, until: new Date(now.getTime() + DAY_MS), startDay,
    })
    const verdict = new Map(classified.map((c) => [c.id, c.verdict]))
    const raw = (r: (typeof rows)[number]) => (r.rawJson ?? {}) as Record<string, any>

    // ── 1. taxonomy evidence ──────────────────────────────────────
    const versions = rows.map((r) => {
      const pfc = raw(r).personal_finance_category ?? {}
      return String(pfc.version ?? raw(r).personal_finance_category_version ?? '(no version field)')
    })
    const present = new Set(rows.map((r) => (r.categoryDetailed ?? '').toUpperCase()))
    table('1. Taxonomy evidence:', [{
      version_field_values: fmtTally(versions),
      v2_only_codes_present: V2_ONLY.filter((c) => present.has(c)).join(', ') || 'none',
      rows_without_rawJson: rows.filter((r) => r.rawJson == null).length,
    }])

    // ── 2. every code on live rows, and where it lands ────────────
    const key = (r: (typeof rows)[number]) =>
      `${Number(r.amount) > 0 ? 'out' : 'in'}|${(r.categoryPrimary ?? '(none)').toUpperCase()}|${(r.categoryDetailed ?? '(none)').toUpperCase()}`
    const groups = new Map<string, string[]>()
    for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), verdict.get(r.id)?.mechanism ?? '(unclassified)'])
    table('2. Every (direction, primary, detailed) on live rows, and the mechanism it lands in:',
      [...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([k, mechs]) => {
        const [direction, primary, detailed] = k.split('|')
        return { direction, primary, detailed, rows: mechs.length, mechanisms: fmtTally(mechs) }
      }))
    const never = [...referenced].filter((c) => !present.has(c)).sort()
    console.log(`   Detailed codes src/ references that never appear for this user (${never.length} of ${referenced.size}):`)
    console.log(`   ${never.join(', ') || '(none)'}\n`)

    // ── 3. transfers out whose other leg Ledger can't see ─────────
    const transferOuts = rows.filter((r) => Number(r.amount) > 0 && (r.categoryDetailed ?? '').toUpperCase().startsWith('TRANSFER_OUT'))
    table('3. Transfers OUT (detailed TRANSFER_OUT_*), by code and verdict:',
      tally(transferOuts.map((r) => `${(r.categoryDetailed ?? '').toUpperCase()} → ${verdict.get(r.id)?.kind ?? '?'} (${verdict.get(r.id)?.mechanism ?? '?'})`))
        .map(([k, n]) => ({ code_and_verdict: k, rows: n })))
    const counted = transferOuts.filter((r) => verdict.get(r.id)?.kind === 'spend')
    const periods = recentPeriods(now, startDay, 6)
    table('   …those counted as SPENDING, as a share of each period\'s spend (period 0 = current):',
      periods.slice().reverse().map((p, i) => {
        const total = spendForPeriod(classified, p.key, startDay, paymentAppByPeriod)
        const mine = counted.filter((r) => periodKeyOf(r.date, startDay) === p.key)
        const sum = mine.reduce((s, r) => s + Number(r.amount), 0)
        return {
          period: String(-i),
          rows: mine.length,
          share_of_spend: total > 0 ? `${((sum / total) * 100).toFixed(1)}%` : '—',
        }
      }))

    // ── 4. payer identity ──────────────────────────────────────────
    const isIncome = (r: (typeof rows)[number]) => verdict.get(r.id)?.kind === 'income'
    const cpEntity = (r: (typeof rows)[number]) => {
      const cps: Array<Record<string, any>> = Array.isArray(raw(r).counterparties) ? raw(r).counterparties : []
      return cps.find((c) => c.entity_id)?.entity_id ?? null
    }
    const KEYS: Array<[string, (r: (typeof rows)[number]) => string | null]> = [
      ['label (old payer key)', (r) => (r.cleanName ?? r.name ?? '').toLowerCase()],
      ['label, normalised (subscription key)', (r) => normalizeMerchant(r.cleanName ?? r.name ?? '')],
      ['merchant_name column', (r) => r.merchantName?.toLowerCase() ?? null],
      ['merchant_entity_id (rawJson)', (r) => raw(r).merchant_entity_id ?? null],
      ['counterparty entity_id (rawJson)', cpEntity],
      ['best available: entity id → merchant_name → normalised', (r) =>
        raw(r).merchant_entity_id ?? cpEntity(r) ?? r.merchantName?.toLowerCase() ?? normalizeMerchant(r.cleanName ?? r.name ?? '')],
    ]
    const grouping = (title: string, codes: string[]) => {
      const mine = rows.filter((r) => isIncome(r) && codes.includes((r.categoryDetailed ?? '').toUpperCase()))
      table(title, KEYS.map(([name, fn]) => {
        const keys = mine.map(fn)
        const sizes = tally(keys.filter((k): k is string => !!k)).map(([, n]) => n)
        return {
          key: name,
          rows_with_field: `${keys.filter(Boolean).length} of ${mine.length}`,
          payers: sizes.length,
          deposits_per_payer: sizes.length ? sizes.slice(0, 8).join(' ') + (sizes.length > 8 ? ' …' : '') : '—',
        }
      }))
    }
    grouping('4a. Salary deposits (classifier income AND INCOME_SALARY / INCOME_WAGES), grouped by each key:', SALARY)
    grouping('4b. Contractor deposits (classifier income AND INCOME_CONTRACTOR), grouped by each key:', CONTRACTOR)

    // The same question for spend: does an entity id hold a merchant together
    // across the description variants subscription detection sees as different?
    const spend = rows.filter((r) => verdict.get(r.id)?.kind === 'spend')
    const byEntity = new Map<string, Set<string>>()
    for (const r of spend) {
      const e = raw(r).merchant_entity_id ?? cpEntity(r)
      if (!e) continue
      byEntity.set(e, (byEntity.get(e) ?? new Set()).add(normalizeMerchant(r.cleanName ?? r.name ?? '')))
    }
    const split = [...byEntity.values()].map((s) => s.size).filter((n) => n > 1).sort((a, b) => b - a)
    table('4c. Spend: entity ids that subscription detection splits into several merchants:', [{
      spend_rows: spend.length,
      with_an_entity_id: spend.filter((r) => raw(r).merchant_entity_id ?? cpEntity(r)).length,
      distinct_entities: byEntity.size,
      entities_split_by_detection: split.length,
      normalised_names_per_split_entity: split.slice(0, 10).join(' ') || '—',
    }])
  }

  await db.prisma.$disconnect()
}

main().catch((e) => {
  console.error(redact(String(e?.stack ?? e)))
  process.exit(1)
})

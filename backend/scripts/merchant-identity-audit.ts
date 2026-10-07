// ─────────────────────────────────────────────────────────────────
//  merchant-identity-audit — Stage 0 of manual subscriptions. READ-ONLY.
//  Counts and fractions only: no amounts, dates, names or ids.
//
//  1. What a backfill from rawJson would fill: per user, how many rows carry
//     merchant_entity_id, a counterparty entity_id, a counterparty type; how
//     often merchant_entity_id is a rail (the same id as a payment_app,
//     payment_terminal, marketplace or financial_institution counterparty);
//     and how pending rows get replaced (pending_transaction_id on posted rows).
//  2. What subscription detection would do if it grouped by merchantIdentity
//     instead of the normalised name: detected subscriptions kept, gained, lost,
//     merged and split. Twice — identity as specified, and with a bridge where a
//     name key seen with exactly one entity id adopts it. And how many groups
//     fail detection only because two amounts recur together (what a series
//     rule would recover), under each key.
//
//  Detection is copied from subscriptions.service.ts (module-private there),
//  with the grouping key as a parameter. Spend rows come from classifyWindow
//  over the same 90 days loadSpendRows reads.
//
//  NOT LIVE CODE: this local logic mirrors the subscription detector M7.6 PR 5f
//  deleted. The tab reads Plaid's stored streams now. Kept as the record of the
//  Stage 0 decision on merchant identity.
//
//    railway run npx tsx scripts/merchant-identity-audit.ts --allow-remote <db host>
// ─────────────────────────────────────────────────────────────────

import { connectReadOnly, redact } from './lib/read-only-db'

const DAY_MS = 86_400_000
const RAILS = new Set(['payment_app', 'payment_terminal', 'marketplace', 'financial_institution'])

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

type Cp = { entity_id?: string | null; type?: string | null }
type Raw = { merchant_entity_id?: string | null; counterparties?: Cp[]; pending_transaction_id?: string | null }

/** The agreed rule. Returns the id it used, or null for the name fallback. */
function entityIdentity(raw: Raw): string | null {
  const cps = Array.isArray(raw.counterparties) ? raw.counterparties : []
  const mid = raw.merchant_entity_id
  if (mid && !cps.some((c) => c.entity_id === mid && RAILS.has((c.type ?? '').toLowerCase()))) return mid
  const merchant = cps.find((c) => c.entity_id && (c.type ?? '').toLowerCase() === 'merchant')
  return merchant?.entity_id ?? null
}

type Row = { id: string; date: Date; amount: number; name: string; raw: Raw }

/** detectCustomRecurring's tests, over one group's rows. True when it would be detected. */
function passes(rows: Row[]): boolean {
  if (rows.length < 3) return false
  const s = [...rows].sort((a, b) => a.date.getTime() - b.date.getTime())
  const gaps = s.slice(1).map((r, i) => (r.date.getTime() - s[i].date.getTime()) / DAY_MS)
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length
  const std = Math.sqrt(gaps.reduce((t, g) => t + (g - avg) ** 2, 0) / gaps.length)
  if (avg < 7 || avg > 32 || std > 7) return false
  const amts = s.map((r) => r.amount)
  const mean = amts.reduce((a, b) => a + b, 0) / amts.length
  return amts.every((a) => Math.abs(a - mean) / mean <= 0.2)
}

/** Amount clusters: sorted amounts split wherever the next is more than 20% above. */
function amountClusters(rows: Row[]): Row[][] {
  const s = [...rows].sort((a, b) => a.amount - b.amount)
  const out: Row[][] = []
  for (const r of s) {
    const cur = out[out.length - 1]
    if (cur && r.amount <= cur[0].amount * 1.2) cur.push(r)
    else out.push([r])
  }
  return out
}

function group(rows: Row[], key: (r: Row) => string): Map<string, Row[]> {
  const m = new Map<string, Row[]>()
  for (const r of rows) {
    const k = key(r)
    m.set(k, [...(m.get(k) ?? []), r])
  }
  return m
}

/** Detected streams under a key, as sets of row ids; plus groups a series rule would recover. */
function detect(rows: Row[], key: (r: Row) => string) {
  const streams: Set<string>[] = []
  let seriesRecoverable = 0
  let seriesExtraStreams = 0
  for (const g of group(rows, key).values()) {
    if (passes(g)) { streams.push(new Set(g.map((r) => r.id))); continue }
    const ok = amountClusters(g).filter(passes)
    if (ok.length > 0) { seriesRecoverable++; seriesExtraStreams += ok.length }
  }
  return { streams, seriesRecoverable, seriesExtraStreams }
}

/** How the streams under key B relate to those under key A. */
function compare(a: Set<string>[], b: Set<string>[]) {
  const owner = (streams: Set<string>[]) => {
    const m = new Map<string, number>()
    streams.forEach((s, i) => s.forEach((id) => m.set(id, i)))
    return m
  }
  const ownA = owner(a), ownB = owner(b)
  let kept = 0, lost = 0, mergedInto = 0, split = 0, gained = 0
  for (const s of a) {
    const targets = new Set([...s].map((id) => ownB.get(id)).filter((x): x is number => x !== undefined))
    if (targets.size === 0) lost++
    else if (targets.size > 1) split++
    else {
      const t = b[[...targets][0]]
      const sources = new Set([...t].map((id) => ownA.get(id)).filter((x) => x !== undefined))
      if (sources.size > 1) mergedInto++
      else kept++
    }
  }
  for (const s of b) if (![...s].some((id) => ownA.has(id))) gained++
  return { before: a.length, after: b.length, kept, lost, merged: mergedInto, split, gained }
}

const pct = (n: number, d: number) => (d === 0 ? '—' : `${((100 * n) / d).toFixed(0)}%`)

async function main() {
  const db = await connectReadOnly('merchant-identity-audit')
  console.log(`\nReading ${db.database} on ${db.host} via ${db.envName} — read-only (${db.writeRefusedWith}).`)
  console.log('Counts and fractions only.\n')

  const { classifyWindow } = await import('../src/services/classification.service')
  const { getPeriodStartDay } = await import('../src/services/user.service')

  const users = await db.prisma.user.findMany({
    where: { transactions: { some: {} } },
    select: { id: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })

  for (const [idx, { id: userId }] of users.entries()) {
    console.log(`════ ${userId === 'demo-user' ? 'demo-user' : `user_n ${idx + 1}`} ════\n`)

    // ── 1. what the backfill fills ────────────────────────────────
    const all = await db.prisma.transaction.findMany({
      where: { userId },
      select: { id: true, pending: true, deletedAt: true, rawJson: true, plaidTransactionId: true },
    })
    const live = all.filter((r) => !r.deletedAt)
    const raw = (r: { rawJson: unknown }) => (r.rawJson ?? {}) as Raw
    const cps = (r: { rawJson: unknown }) => (Array.isArray(raw(r).counterparties) ? raw(r).counterparties! : [])
    const n = live.length
    const c = {
      noRawJson: live.filter((r) => r.rawJson == null).length,
      mid: live.filter((r) => raw(r).merchant_entity_id).length,
      cpEntity: live.filter((r) => cps(r).some((x) => x.entity_id)).length,
      cpType: live.filter((r) => cps(r).some((x) => x.type)).length,
      midIsRail: live.filter((r) => {
        const mid = raw(r).merchant_entity_id
        return mid && cps(r).some((x) => x.entity_id === mid && RAILS.has((x.type ?? '').toLowerCase()))
      }).length,
      identityFromId: live.filter((r) => entityIdentity(raw(r))).length,
    }
    console.log('1. Backfill coverage (live rows)')
    console.log(`   rows: ${n}; without rawJson: ${pct(c.noRawJson, n)}`)
    console.log(`   merchant_entity_id: ${pct(c.mid, n)}; a counterparty entity_id: ${pct(c.cpEntity, n)}; a counterparty type: ${pct(c.cpType, n)}`)
    console.log(`   merchant_entity_id that is a rail's id: ${pct(c.midIsRail, c.mid)} of rows that have one`)
    console.log(`   identity from an id under the rule: ${pct(c.identityFromId, n)}; name fallback: ${pct(n - c.identityFromId, n)}`)

    // Pending replacement: how a posted row points back at the pending row it replaced.
    const byPlaidId = new Map(all.map((r) => [r.plaidTransactionId, r]))
    const posted = live.filter((r) => !r.pending)
    const pointing = posted.filter((r) => raw(r).pending_transaction_id)
    const resolvable = pointing.filter((r) => byPlaidId.has(raw(r).pending_transaction_id!))
    const replacedSoftDeleted = resolvable.filter((r) => byPlaidId.get(raw(r).pending_transaction_id!)!.deletedAt)
    console.log(`   posted rows naming a pending_transaction_id: ${pct(pointing.length, posted.length)}; ` +
      `of those, the pending row is stored: ${pct(resolvable.length, pointing.length)}, and soft-deleted: ${pct(replacedSoftDeleted.length, resolvable.length)}`)
    console.log(`   pending rows now live: ${live.filter((r) => r.pending).length > 0 ? 'yes' : 'no'}\n`)

    // ── 2. detection under each key ───────────────────────────────
    const now = new Date()
    const since = new Date(now.getTime() - 90 * DAY_MS)
    const startDay = await getPeriodStartDay(userId)
    const { rows: classified } = await classifyWindow(userId, { since, until: now, startDay })
    const rawById = new Map(all.map((r) => [r.id, raw(r)]))
    const spend: Row[] = classified
      .filter((r) => r.verdict.kind === 'spend' && r.amount > 0)
      .map((r) => ({ id: r.id, date: r.date, amount: r.amount, name: r.merchantLabel, raw: rawById.get(r.id) ?? {} }))

    const byName = (r: Row) => `n:${normalizeMerchant(r.name)}`
    const byIdentity = (r: Row) => {
      const id = entityIdentity(r.raw)
      return id ? `e:${id}` : byName(r)
    }
    // Bridge: a name key that, in this window, is seen with exactly one entity id adopts it.
    const idsPerName = new Map<string, Set<string>>()
    for (const r of spend) {
      const id = entityIdentity(r.raw)
      if (!id) continue
      const k = byName(r)
      idsPerName.set(k, new Set([...(idsPerName.get(k) ?? []), id]))
    }
    const byBridged = (r: Row) => {
      const id = entityIdentity(r.raw)
      if (id) return `e:${id}`
      const ids = idsPerName.get(byName(r))
      return ids && ids.size === 1 ? `e:${[...ids][0]}` : byName(r)
    }

    const name = detect(spend, byName)
    const ident = detect(spend, byIdentity)
    const bridged = detect(spend, byBridged)
    const namesWithSeveralIds = [...idsPerName.values()].filter((s) => s.size > 1).length

    console.log('2. Detection: spend rows in the 90-day window, grouped three ways')
    console.log(`   spend rows with an id under the rule: ${pct(spend.filter((r) => entityIdentity(r.raw)).length, spend.length)}`)
    console.log(`   name keys seen with more than one entity id: ${namesWithSeveralIds}`)
    const rows = [
      { key: 'merchantIdentity', ...compare(name.streams, ident.streams) },
      { key: 'identity + name bridge', ...compare(name.streams, bridged.streams) },
    ]
    console.log('   compared with today (normalised name):')
    console.log('     ' + ['key', 'before', 'after', 'kept', 'gained', 'lost', 'merged', 'split'].join('  '))
    for (const r of rows) {
      console.log('     ' + [r.key, r.before, r.after, r.kept, r.gained, r.lost, r.merged, r.split].join('  '))
    }
    console.log('   groups that fail only because several amounts recur together (series rule would recover):')
    for (const [k, d] of [['name', name], ['merchantIdentity', ident], ['identity + bridge', bridged]] as const) {
      console.log(`     ${k}: ${d.seriesRecoverable} group(s), ${d.seriesExtraStreams} stream(s)`)
    }
    console.log()
  }

  await db.prisma.$disconnect()
}

main().catch((e) => {
  console.error(redact(String(e?.stack ?? e)))
  process.exit(1)
})

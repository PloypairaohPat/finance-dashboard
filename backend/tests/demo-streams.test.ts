// ─────────────────────────────────────────────────────────────────
//  The demo's recurring streams (M7.6 PR 5b). Each stream, and the marked
//  gym, states what the Subscriptions tab must show once it reads streams;
//  this writes the seed's own plan under a test user and checks every one
//  against composeSubscriptions, the function PR 5e wires to the tab.
//
//  The demo user in the test database is never touched: the plan is written
//  under its own user, with its Plaid ids prefixed (they're unique columns).
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import prisma from '../src/lib/prisma'
import { buildDemoDataset, type DemoDataset, type ExpectedComposed } from '../prisma/demo-dataset'
import { buildPlan, type Plan } from '../prisma/demo-plan'
import { CREATE_ORDER, WIPE_ORDER } from '../prisma/demo-tables'
import { composeSubscriptions, type ComposedAnalysis } from '../src/services/streamComposition.service'
import { detectSubscriptionPriceUp } from '../src/services/alerts/detectors/subscriptionPriceUp'
import type { DetectedAlert, DetectorContext } from '../src/services/alerts/types'

const ds = buildDemoDataset(new Date())

describe('the demo streams as data', () => {
  it('every stream id carries the FAKE marker, and every stream names charges the demo has', () => {
    const ids = new Set(ds.transactions.map((t) => t.plaidTransactionId))
    for (const s of ds.streams) {
      expect(s.streamId, s.streamId).toMatch(/^FAKE-/)
      expect(s.txIds.length, s.streamId).toBeGreaterThan(0)
      for (const id of s.txIds) expect(ids.has(id), `${s.streamId} names ${id}`).toBe(true)
    }
    expect(new Set(ds.streams.map((s) => s.streamId)).size).toBe(ds.streams.length)
  })

  it('no charge is in two streams', () => {
    const all = ds.streams.flatMap((s) => s.txIds)
    expect(new Set(all).size).toBe(all.length)
  })

  it('has one of each state a demo visitor would otherwise never see', () => {
    const has = (pred: (e: ExpectedComposed, s: DemoDataset['streams'][number]) => boolean) =>
      ds.streams.filter((s) => pred(s.expected, s)).map((s) => s.streamId)
    expect(has((e) => e.list === 'suggested' && !e.isNew), 'a plain suggestion').not.toEqual([])
    expect(has((e, s) => e.list === 'suggested' && e.isNew && s.status === 'EARLY_DETECTION'), 'a new one').not.toEqual([])
    expect(has((e) => e.list === 'dismissed'), 'a dismissed one').not.toEqual([])
    expect(has((e, s) => e.list === 'bills' && e.marked && s.detailed.startsWith('TRANSFER_OUT')), 'a payment to a person confirmed into Bills').not.toEqual([])
    expect(has((e, s) => (e.list === 'subscriptions' || e.list === 'bills') && e.marked && e.status === 'ended' && !s.isActive), 'a confirmed one that ended').not.toEqual([])
    expect(has((e) => e.list === 'subscriptions' && !e.marked && e.priceUp === true), 'the price rise').not.toEqual([])
    expect(ds.markedSeries.map((m) => m.expected), 'the marked gym').toEqual([{ list: 'subscriptions', status: 'active', marked: true, priceUp: true }])
  })

  it('every verdict is on a stream charge or a marked series anchor, and every marked stream has one', () => {
    const streamOf = new Map(ds.streams.flatMap((s) => s.txIds.map((id) => [id, s] as const)))
    const anchors = new Set(ds.markedSeries.map((m) => m.anchor))
    for (const v of ds.verdicts) expect(streamOf.has(v.plaidTransactionId) || anchors.has(v.plaidTransactionId), v.plaidTransactionId).toBe(true)
    for (const s of ds.streams) {
      const kinds = ds.verdicts.filter((v) => s.txIds.includes(v.plaidTransactionId)).map((v) => v.kind)
      const e = s.expected
      expect(kinds, s.streamId).toEqual(e.list === 'dismissed' ? ['dismissed'] : (e.list === 'subscriptions' || e.list === 'bills') && e.marked ? ['confirmed'] : [])
    }
  })

  it('the seed plan carries every stream and every verdict, with its kind', () => {
    const plan = buildPlan(ds)
    expect(plan.recurringStream).toHaveLength(ds.streams.length)
    expect(plan.subscriptionMark.map((m) => m.kind).sort()).toEqual(ds.verdicts.map((v) => v.kind).sort())
    // Transaction.amount's sign: an outflow positive, an inflow negative.
    for (const st of plan.recurringStream) {
      expect(Math.sign(Number(st.lastAmount)), st.streamId).toBe(st.direction === 'outflow' ? 1 : -1)
    }
  })
})

// ── the composed result, from the seed's own plan ─────────────────

const USER = 'demo-streams-test-user'
const P = 'dst-'

/** The dataset with every globally unique Plaid id prefixed, so it can sit beside the demo. */
function prefixed(d: DemoDataset): DemoDataset {
  const id = (x: string) => `${P}${x}`
  return {
    ...d,
    items: d.items.map((i) => ({ ...i, itemId: id(i.itemId) })),
    accounts: d.accounts.map((a) => ({ ...a, plaidAccountId: id(a.plaidAccountId) })),
    transactions: d.transactions.map((t) => ({ ...t, plaidTransactionId: id(t.plaidTransactionId) })),
    cases: d.cases.map((c) => ({ ...c, txIds: c.txIds.map(id) })),
    streams: d.streams.map((s) => ({ ...s, txIds: s.txIds.map(id) })),
    verdicts: d.verdicts.map((v) => ({ ...v, plaidTransactionId: id(v.plaidTransactionId) })),
    markedSeries: d.markedSeries.map((m) => ({ ...m, anchor: id(m.anchor) })),
  }
}

async function wipe() {
  for (const table of WIPE_ORDER) await (prisma[table] as any).deleteMany({ where: { userId: USER } })
  await prisma.user.deleteMany({ where: { id: USER } })
}

describe('what the tab shows for the demo, on streams', () => {
  let plan: Plan
  let result: ComposedAnalysis
  let rowId: Map<string, string>

  beforeAll(async () => {
    await wipe()
    plan = buildPlan(prefixed(ds), USER)
    await prisma.user.create({ data: { id: USER, email: `${USER}@demo-streams-test.local`, periodStartDay: ds.startDay } })
    for (const table of CREATE_ORDER) await (prisma[table] as any).createMany({ data: plan[table] })
    rowId = new Map(plan.transaction.map((t) => [t.plaidTransactionId, t.id as string]))
    result = await composeSubscriptions(USER, ds.now)
  })
  afterAll(wipe)

  const lists = () => ({
    subscriptions: result.subscriptions, bills: result.bills, suggested: result.suggested, dismissed: result.dismissed,
  })
  /** The one list and item holding a charge. Fails if it's in none or in two. */
  function placeOf(chargeId: string) {
    const hits = Object.entries(lists()).flatMap(([list, xs]) => xs.filter((s) => s.txIds.includes(chargeId)).map((s) => ({ list, s })))
    expect(hits.map((h) => h.list), `charge ${chargeId}`).toHaveLength(1)
    return hits[0]
  }

  function check(expected: ExpectedComposed, chargeIds: string[], label: string) {
    if (expected.list === 'hidden') {
      // An inflow: none of its charges in any list.
      for (const id of chargeIds) {
        expect(Object.values(lists()).flat().some((x) => x.txIds.includes(id)), `${label}: ${id}`).toBe(false)
      }
      return
    }
    const { list, s } = placeOf(chargeIds[chargeIds.length - 1])
    expect(list, label).toBe(expected.list)
    // Every charge of the fixture is in that one item.
    for (const id of chargeIds) expect(s.txIds, `${label}: ${id}`).toContain(id)
    if (expected.list === 'subscriptions' || expected.list === 'bills') {
      expect(s.status, label).toBe(expected.status)
      expect(s.mark !== null, label).toBe(expected.marked)
      if (expected.priceUp) expect(s.priceChange?.pctChange ?? 0, label).toBeGreaterThan(0)
    } else if (expected.list === 'suggested') {
      expect({ isNew: (s as any).isNew, confirmsAs: (s as any).confirmsAs }, label).toEqual({ isNew: expected.isNew, confirmsAs: expected.confirmsAs })
    } else {
      expect(s.mark, label).not.toBeNull() // the dismissal, for Restore
    }
  }

  it.each(ds.streams.map((s) => [s.streamId, s] as const))('%s shows as it states', (_, s) => {
    check(s.expected, s.txIds.map((id) => rowId.get(`${P}${id}`)!), s.streamId)
  })

  it('the marked gym shows as marked, through its series', () => {
    for (const m of ds.markedSeries) {
      const anchor = rowId.get(`${P}${m.anchor}`)!
      const { s } = placeOf(anchor)
      check(m.expected, [anchor], m.note)
      expect(s.source).toBe('custom')
    }
  })

  it('shows nothing the fixtures do not declare, and no charge twice', () => {
    const declared = ds.streams.filter((s) => s.expected.list !== 'hidden').length + ds.markedSeries.length
    const shown = Object.values(lists()).flat()
    expect(shown).toHaveLength(declared)
    const ids = [...result.subscriptions, ...result.bills, ...result.suggested].flatMap((s) => s.txIds)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('the bell gets the price rises: the stream and the marked gym', () => {
    const ctx = { now: ds.now, subscriptions: { ok: true, analysis: result } } as unknown as DetectorContext
    // The detector is synchronous; its type allows a promise for the ones that aren't.
    const merchants = (detectSubscriptionPriceUp(ctx) as DetectedAlert[]).map((a) => a.title)
    expect(merchants).toHaveLength(2)
    expect(merchants.some((t) => t.startsWith('Viewloom'))).toBe(true)
  })
})

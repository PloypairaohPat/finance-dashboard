// ─────────────────────────────────────────────────────────────────
//  M7.6 PR 5a: the composed result (sorting + verdicts) and the one
//  monthly-amount definition. Not wired to any endpoint yet.
//  Each scenario has its own user. All names, ids and amounts are invented.
// ─────────────────────────────────────────────────────────────────

import { afterAll, describe, expect, it } from 'vitest'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'
import { BILL_MEAN_OF, monthlyAmount, perMonth } from '../src/lib/monthlyAmount'
import { composeSubscriptions, type ComposedAnalysis } from '../src/services/streamComposition.service'

describe('monthlyAmount', () => {
  it("a subscription's is its last posted charge, per month", () => {
    expect(monthlyAmount('subscription', [10, 10, 12], 'MONTHLY')).toBe(12)
    expect(monthlyAmount('subscription', [120], 'ANNUALLY')).toBe(10)
    expect(monthlyAmount('subscription', [5], 'WEEKLY')).toBe(21.65)
  })
  it(`a bill's is the mean of its last ${BILL_MEAN_OF} posted charges, or fewer if that's all`, () => {
    expect(monthlyAmount('bill', [40, 50, 60, 70], 'MONTHLY')).toBe(60)
    expect(monthlyAmount('bill', [50, 70], 'MONTHLY')).toBe(60)
    expect(monthlyAmount('bill', [30, 30, 30], 'BIWEEKLY')).toBe(65.1)
  })
  it('nothing posted, or an UNKNOWN frequency, has no monthly amount', () => {
    expect(monthlyAmount('subscription', [], 'MONTHLY')).toBeNull()
    expect(monthlyAmount('bill', [50], 'UNKNOWN')).toBeNull()
    expect(perMonth(50, 'UNKNOWN')).toBeNull()
  })
  it.each([['WEEKLY', 43.3], ['BIWEEKLY', 21.7], ['SEMI_MONTHLY', 20], ['MONTHLY', 10], ['ANNUALLY', 0.83]] as const)(
    'one charge of 10, %s, is %s a month', (f, n) => expect(perMonth(10, f)).toBe(n))
})

// ── fixtures ──────────────────────────────────────────────────────

const PREFIX = 'stream-compose-test'
const DAY = 86_400_000
const now = new Date()
const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
const ago = (days: number) => new Date(today - days * DAY)
const CAT = {
  tv: ['ENTERTAINMENT', 'ENTERTAINMENT_TV_AND_MOVIES'],
  gym: ['PERSONAL_CARE', 'PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS'],
  power: ['RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY'],
  doctor: ['MEDICAL', 'MEDICAL_PRIMARY_CARE'],
} as const

interface World { userId: string; itemId: string; accountId: string; n: number }

async function world(suffix: string): Promise<World> {
  const userId = `${PREFIX}-${suffix}`
  await prisma.user.create({ data: { id: userId, email: `${userId}@compose-test.local` } })
  const item = await prisma.plaidItem.create({ data: { userId, itemId: `${userId}-item`, accessToken: encrypt(`fake-${userId}`), institutionName: `${userId}-Bank` } })
  const account = await prisma.account.create({
    data: { userId, plaidItemId: item.id, plaidAccountId: `${userId}-card`, name: 'Card', type: 'credit', subtype: 'credit card', isoCurrencyCode: 'USD' },
  })
  return { userId, itemId: item.id, accountId: account.id, n: 0 }
}

/** One charge; returns its row id and Plaid id. */
async function charge(w: World, daysAgo: number, amount: number, name: string, cat: readonly [string, string], opts: { pending?: boolean; entity?: string } = {}) {
  const plaidTransactionId = `${w.userId}-tx-${++w.n}`
  const [primary, detailed] = cat
  const t = await prisma.transaction.create({
    data: {
      userId: w.userId, accountId: w.accountId, plaidTransactionId, date: ago(daysAgo), amount: amount.toFixed(2),
      name, cleanName: name, categoryPrimary: primary, categoryDetailed: detailed, pending: opts.pending ?? false, isoCurrencyCode: 'USD',
      merchantEntityId: opts.entity ?? null, counterpartyEntities: opts.entity ? [`merchant:${opts.entity}`] : [],
      rawJson: {
        personal_finance_category: { primary, detailed, confidence_level: 'VERY_HIGH' },
        merchant_entity_id: opts.entity ?? null,
        counterparties: opts.entity ? [{ name, type: 'merchant', entity_id: opts.entity }] : [],
      },
    },
  })
  return { id: t.id, plaidId: plaidTransactionId }
}

/** Monthly charges of one merchant, oldest first. */
async function series(w: World, amounts: number[], name: string, cat: readonly [string, string], opts: { lastPending?: boolean; entity?: string } = {}) {
  const out = []
  for (const [i, a] of amounts.entries()) {
    const isLast = i === amounts.length - 1
    out.push(await charge(w, 5 + 30 * (amounts.length - 1 - i), a, name, cat, { pending: isLast && opts.lastPending, entity: opts.entity }))
  }
  return out
}

async function stream(w: World, charges: Array<{ plaidId: string }>, name: string, cat: readonly [string, string], o: {
  status?: string; frequency?: string; isActive?: boolean; predictedNextDate?: Date | null; ids?: string[]
} = {}) {
  return prisma.recurringStream.create({
    data: {
      userId: w.userId, plaidItemId: w.itemId, streamId: `FAKE-${w.userId}-${++w.n}`, plaidAccountId: `${w.userId}-card`,
      direction: 'outflow', description: name, merchantName: name, pfcPrimary: cat[0], pfcDetailed: cat[1],
      frequency: o.frequency ?? 'MONTHLY', status: o.status ?? 'MATURE', isActive: o.isActive ?? true,
      firstDate: ago(90), lastDate: ago(5), predictedNextDate: o.predictedNextDate ?? null,
      plaidTransactionIds: o.ids ?? charges.map((c) => c.plaidId), plaidUpdatedAt: new Date(),
    },
  })
}

const verdict = (w: World, transactionId: string, kind: 'confirmed' | 'dismissed', at: Date = new Date()) =>
  prisma.subscriptionMark.create({ data: { userId: w.userId, transactionId, kind, createdAt: at } })

const compose = (w: World) => composeSubscriptions(w.userId, now)
const all = (r: ComposedAnalysis) => [...r.subscriptions, ...r.bills, ...r.suggested]
const names = (xs: Array<{ merchant: string }>) => xs.map((x) => x.merchant).sort()
/** Each charge at most once across everything shown or suggested. */
function expectNoChargeTwice(r: ComposedAnalysis) {
  const ids = all(r).flatMap((s) => s.txIds)
  expect(new Set(ids).size).toBe(ids.length)
}

afterAll(async () => {
  const where = { userId: { startsWith: PREFIX } }
  await prisma.subscriptionMark.deleteMany({ where })
  await prisma.recurringStream.deleteMany({ where })
  await prisma.transaction.deleteMany({ where })
  await prisma.account.deleteMany({ where })
  await prisma.plaidItem.deleteMany({ where })
  await prisma.user.deleteMany({ where: { id: { startsWith: PREFIX } } })
})

// ── composition ───────────────────────────────────────────────────

describe('composeSubscriptions', () => {
  it('a subscription stream: its last posted charge, counted, from Plaid', async () => {
    const w = await world('sub')
    await stream(w, await series(w, [10, 10, 12], 'STREAMCO', CAT.tv), 'StreamCo', CAT.tv)
    const r = await compose(w)
    expect(r.subscriptions).toHaveLength(1)
    expect(r.subscriptions[0]).toMatchObject({ merchant: 'StreamCo', kind: 'subscription', monthlyAmount: 12, source: 'plaid', status: 'active', mark: null })
    expect(r.subscriptions[0].priceChange).toEqual({ previousAmount: 10, pctChange: 20 })
    expect(r.totals.monthlySubscriptions).toBe(12)
    expect(r.suggested).toEqual([])
  })

  it("a bill stream: the mean of its last 3 posted charges", async () => {
    const w = await world('bill')
    await stream(w, await series(w, [40, 50, 60, 70], 'POWERCO', CAT.power), 'PowerCo', CAT.power)
    const r = await compose(w)
    expect(r.bills.map((b) => b.monthlyAmount)).toEqual([60])
    expect(r.totals).toEqual({ monthlySubscriptions: 0, monthlyBills: 60, monthlyAll: 60 })
  })

  it('a pending last charge is shown as pending but left out of the amount and the price change', async () => {
    const w = await world('pending')
    await stream(w, await series(w, [10, 10, 12], 'STREAMCO', CAT.tv, { lastPending: true }), 'StreamCo', CAT.tv)
    const [s] = (await compose(w)).subscriptions
    expect(s).toMatchObject({ lastAmount: 12, lastChargePending: true, monthlyAmount: 10, priceChange: null })
  })

  it('an UNKNOWN frequency is listed but adds nothing; an inactive stream shows as ended, uncounted', async () => {
    const w = await world('uncounted')
    await stream(w, await series(w, [9, 9, 9], 'ODDCO', CAT.tv), 'OddCo', CAT.tv, { frequency: 'UNKNOWN' })
    await stream(w, await series(w, [7, 7, 7], 'GONECO', CAT.tv), 'GoneCo', CAT.tv, { isActive: false })
    const r = await compose(w)
    expect(names(r.subscriptions)).toEqual(['GoneCo', 'OddCo'])
    expect(r.subscriptions.find((s) => s.merchant === 'GoneCo')!.status).toBe('ended')
    expect(r.totals.monthlyAll).toBe(0)
    expect(r.upcoming).toEqual([])
  })

  it('a suggestion is listed apart, outside every total; EARLY_DETECTION is flagged as new', async () => {
    const w = await world('suggest')
    await stream(w, await series(w, [80, 80, 80], 'CLINIC', CAT.doctor), 'Clinic', CAT.doctor)
    await stream(w, await series(w, [15], 'NEWFLIX', CAT.tv), 'Newflix', CAT.tv, { status: 'EARLY_DETECTION' })
    const r = await compose(w)
    expect(r.subscriptions).toEqual([])
    expect(r.totals.monthlyAll).toBe(0)
    expect(r.suggested.map((s) => [s.merchant, s.isNew, s.confirmsAs, s.reason]).sort()).toEqual([
      ['Clinic', false, 'subscription', 'category-unlisted'],
      ['Newflix', true, 'subscription', 'early-detection'],
    ])
    expect(r.suggested.every((s) => s.nextChargeDate === null)).toBe(true)
  })

  it('a confirmed suggestion lands where confirmsAs says, counted', async () => {
    const w = await world('confirm')
    const c = await series(w, [55, 65, 75], 'NEWPOWER', CAT.power)
    await stream(w, c, 'NewPower', CAT.power, { status: 'EARLY_DETECTION' })
    const m = await verdict(w, c[0].id, 'confirmed')
    const r = await compose(w)
    expect(r.suggested).toEqual([])
    expect(r.bills).toHaveLength(1)
    expect(r.bills[0]).toMatchObject({ merchant: 'NewPower', mark: { id: m.id }, monthlyAmount: 65, status: 'active' })
    expect(r.totals.monthlyBills).toBe(65)
  })

  it('a confirmed inactive stream shows as ended in its bucket, overriding ended-unconfirmed', async () => {
    const w = await world('confirm-ended')
    const c = await series(w, [20, 20, 20], 'OLDCLINIC', CAT.doctor)
    await stream(w, c, 'OldClinic', CAT.doctor, { isActive: false })
    expect(all(await compose(w))).toEqual([]) // hidden as ended-unconfirmed
    await verdict(w, c[1].id, 'confirmed')
    const r = await compose(w)
    expect(r.subscriptions.map((s) => [s.merchant, s.status])).toEqual([['OldClinic', 'ended']])
    expect(r.totals.monthlyAll).toBe(0)
  })

  it('a dismissal hides a stream, and lists it for Restore with the dismissal id', async () => {
    const w = await world('dismiss')
    const c = await series(w, [10, 10, 10], 'STREAMCO', CAT.tv)
    await stream(w, c, 'StreamCo', CAT.tv)
    const d = await verdict(w, c[2].id, 'dismissed')
    const r = await compose(w)
    expect(all(r)).toEqual([])
    expect(r.totals.monthlyAll).toBe(0)
    expect(r.dismissed.map((s) => [s.merchant, s.mark?.id])).toEqual([['StreamCo', d.id]])
  })

  it('the latest verdict on any of its charges wins', async () => {
    const w = await world('latest')
    const c = await series(w, [10, 10, 10], 'STREAMCO', CAT.tv)
    await stream(w, c, 'StreamCo', CAT.tv)
    await verdict(w, c[0].id, 'confirmed', ago(3))
    await verdict(w, c[1].id, 'dismissed', ago(2))
    expect((await compose(w)).subscriptions).toEqual([])
    const again = await verdict(w, c[2].id, 'confirmed', ago(1))
    const r = await compose(w)
    expect(r.subscriptions.map((s) => s.mark?.id)).toEqual([again.id])
    expect(r.dismissed).toEqual([])
  })

  it('a confirmation on a charge in no stream is a marked subscription, as today', async () => {
    const w = await world('lone')
    const [c] = await series(w, [30], 'LONEGYM', CAT.gym)
    const m = await verdict(w, c.id, 'confirmed')
    const r = await compose(w)
    expect(r.subscriptions.map((s) => [s.merchant, s.mark?.id, s.source, s.frequency])).toEqual([['LONEGYM', m.id, 'custom', 'UNKNOWN']])
  })

  it('a mark on a charge in a stream the sorting hides (tombstoned) is walked as today', async () => {
    const w = await world('tomb')
    const c = await series(w, [25, 25, 25], 'TOMBGYM', CAT.gym)
    await stream(w, c, 'TombGym', CAT.gym, { status: 'TOMBSTONED', isActive: false })
    await verdict(w, c[0].id, 'confirmed')
    const r = await compose(w)
    expect(r.subscriptions.map((s) => [s.merchant, s.source])).toEqual([['TOMBGYM', 'custom']])
  })

  it("the gym: a stream Plaid forms from a marked series' charges folds into the mark, shown once", async () => {
    const w = await world('gym')
    const gym = await series(w, [39, 39, 45, 45], 'IRONGYM', CAT.gym, { entity: 'FAKE-entity-irongym' })
    // Plaid's stream holds the last three; the user marked the first.
    await stream(w, gym.slice(1), 'IronGym', CAT.gym)
    const m = await verdict(w, gym[0].id, 'confirmed')
    // A neighbour stream that shares nothing still shows.
    await stream(w, await series(w, [10, 10, 10], 'STREAMCO', CAT.tv), 'StreamCo', CAT.tv)
    const r = await compose(w)
    expect(r.subscriptions.map((s) => [s.merchant, s.mark?.id ?? null]).sort()).toEqual([['IRONGYM', m.id], ['StreamCo', null]])
    expect(r.subscriptions.find((s) => s.mark)!.txIds.sort()).toEqual(gym.map((g) => g.id).sort())
    expectNoChargeTwice(r)
    // Counted once: the gym's last posted charge plus StreamCo's.
    expect(r.totals.monthlySubscriptions).toBe(55)
  })

  it('no charge is shown twice, and totals are the sum of what counts', async () => {
    const w = await world('invariant')
    const tv = await series(w, [10, 11, 12], 'STREAMCO', CAT.tv)
    await stream(w, tv, 'StreamCo', CAT.tv)
    // A second stream naming two of the same charges (Plaid regrouped): folded.
    await stream(w, tv.slice(1), 'StreamCo Again', CAT.tv)
    await stream(w, await series(w, [40, 50, 60], 'POWERCO', CAT.power), 'PowerCo', CAT.power)
    await stream(w, await series(w, [80, 80, 80], 'CLINIC', CAT.doctor), 'Clinic', CAT.doctor)
    const r = await compose(w)
    expectNoChargeTwice(r)
    expect(names(r.subscriptions)).toEqual(['StreamCo'])
    const counted = [...r.subscriptions, ...r.bills].filter((s) => s.status === 'active' && s.frequency !== 'UNKNOWN')
    expect(r.totals.monthlyAll).toBe(Number(counted.reduce((n, s) => n + s.monthlyAmount, 0).toFixed(2)))
    expect(r.totals.monthlyAll).toBe(62)
  })

  it("next charge: Plaid's predicted date when it's ahead, our own when it has passed", async () => {
    const w = await world('next')
    await stream(w, await series(w, [10, 10, 10], 'AHEADCO', CAT.tv), 'AheadCo', CAT.tv, { predictedNextDate: ago(-9) })
    await stream(w, await series(w, [10, 10, 10], 'PASTCO', CAT.tv), 'PastCo', CAT.tv, { predictedNextDate: ago(3) })
    const r = await compose(w)
    const ahead = r.subscriptions.find((s) => s.merchant === 'AheadCo')!
    expect(ahead.daysUntilNextCharge).toBe(9)
    const past = r.subscriptions.find((s) => s.merchant === 'PastCo')!
    expect(past.daysUntilNextCharge).toBeGreaterThanOrEqual(0)
    expect(past.nextChargeDate).not.toBe(ago(3).toISOString().slice(0, 10))
    expect(r.upcoming.map((s) => s.merchant)).toContain('AheadCo')
  })

  it("isolation: a stream naming another user's charges shows nothing, and their verdicts don't reach it", async () => {
    const a = await world('iso-a')
    const b = await world('iso-b')
    const bCharges = await series(b, [10, 10, 10], 'BSTREAM', CAT.tv)
    await stream(b, bCharges, 'BStream', CAT.tv)
    await verdict(b, bCharges[0].id, 'dismissed')
    await stream(a, [], 'AStream', CAT.tv, { ids: bCharges.map((c) => c.plaidId) })
    const r = await compose(a)
    expect(all(r)).toEqual([])
    expect(r.dismissed).toEqual([])
    expect((await compose(b)).dismissed.map((s) => s.merchant)).toEqual(['BStream'])
  })
})

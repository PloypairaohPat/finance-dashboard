// ─────────────────────────────────────────────────────────────────
//  The one definition (M7.6 PR 3): every branch of sortStream, and the
//  resolution of a stream's transaction ids to the stream's own user's rows.
//  All ids, names and amounts are invented.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'
import type { ClassKind } from '../src/lib/classifier'
import { sortStream, type SortInput } from '../src/lib/streamSorting'
import { resolveStreamRows, sortUserStreams } from '../src/services/streamSorting.service'

/** A mature, active, monthly streaming subscription whose charges are all spend. */
const base: SortInput = {
  direction: 'outflow',
  status: 'MATURE',
  frequency: 'MONTHLY',
  isActive: true,
  pfcPrimary: 'ENTERTAINMENT',
  pfcDetailed: 'ENTERTAINMENT_TV_AND_MOVIES',
  verdicts: ['spend', 'spend', 'spend'],
}
const sort = (over: Partial<SortInput>) => sortStream({ ...base, ...over })
const cat = (pfcPrimary: string | null, pfcDetailed: string | null) => sort({ pfcPrimary, pfcDetailed })

describe('sortStream', () => {
  it('a mature, active, monthly service paid as spend is a subscription that counts', () => {
    expect(sortStream(base)).toEqual({ bucket: 'subscription', reason: 'subscription-category', counts: true })
  })

  describe('1. direction', () => {
    it('an inflow is hidden, whatever else it is', () => {
      expect(sort({ direction: 'inflow', verdicts: ['income'] })).toEqual({ bucket: 'hidden', reason: 'inflow', counts: false })
    })
  })

  describe('2. status', () => {
    it("a status Plaid doesn't document is hidden, not folded into UNKNOWN", () => {
      expect(sort({ status: 'MERGED' })).toMatchObject({ bucket: 'hidden', reason: 'status-unrecognised' })
      expect(sort({ status: 'mature' })).toMatchObject({ bucket: 'hidden', reason: 'status-unrecognised' })
    })
    it('TOMBSTONED is hidden', () => {
      expect(sort({ status: 'TOMBSTONED', isActive: false })).toMatchObject({ bucket: 'hidden', reason: 'tombstoned' })
    })
    it('EARLY_DETECTION is suggested whatever its category, and keeps where it would land', () => {
      expect(sort({ status: 'EARLY_DETECTION' })).toEqual({ bucket: 'suggested', reason: 'early-detection', counts: false, confirmsAs: 'subscription' })
      expect(sort({ status: 'EARLY_DETECTION', pfcPrimary: 'RENT_AND_UTILITIES', pfcDetailed: 'RENT_AND_UTILITIES_RENT' }))
        .toEqual({ bucket: 'suggested', reason: 'early-detection', counts: false, confirmsAs: 'bill' })
      expect(sort({ status: 'EARLY_DETECTION', pfcPrimary: 'FOOD_AND_DRINK', pfcDetailed: 'FOOD_AND_DRINK_COFFEE' }))
        .toMatchObject({ bucket: 'suggested', reason: 'early-detection' })
    })
    it('EARLY_DETECTION still never shows a transfer', () => {
      expect(sort({ status: 'EARLY_DETECTION', verdicts: ['card_payment'] })).toMatchObject({ bucket: 'hidden', reason: 'transfer' })
    })
    it('UNKNOWN status is suggested, not assumed', () => {
      expect(sort({ status: 'UNKNOWN' })).toEqual({ bucket: 'suggested', reason: 'status-unknown', counts: false, confirmsAs: 'subscription' })
    })
  })

  describe("3. our classifier's verdict on its transactions", () => {
    it('none of its transactions in our rows: hidden as unmatched', () => {
      expect(sort({ verdicts: [] })).toMatchObject({ bucket: 'hidden', reason: 'unmatched' })
    })
    it('some spend and some not: hidden as mixed', () => {
      expect(sort({ verdicts: ['spend', 'card_payment'] })).toMatchObject({ bucket: 'hidden', reason: 'mixed' })
      expect(sort({ verdicts: ['spend', 'refund'] })).toMatchObject({ bucket: 'hidden', reason: 'mixed' })
    })
    it.each<ClassKind>(['card_payment', 'internal_transfer', 'savings_transfer'])('all %s: hidden as a transfer, even in a bill category', (kind) => {
      expect(sort({ verdicts: [kind, kind], pfcPrimary: 'LOAN_PAYMENTS', pfcDetailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' }))
        .toMatchObject({ bucket: 'hidden', reason: 'transfer' })
    })
    it('all transfers of different kinds are still all transfer, not mixed', () => {
      expect(sort({ verdicts: ['card_payment', 'internal_transfer'] })).toMatchObject({ bucket: 'hidden', reason: 'transfer' })
    })
    it.each<ClassKind>(['income', 'refund', 'payment_app_in', 'credit_inflow_not_income', 'unclassified_inflow'])('all %s on an outflow stream: hidden as not spend', (kind) => {
      expect(sort({ verdicts: [kind] })).toMatchObject({ bucket: 'hidden', reason: 'not-spend' })
    })
  })

  describe('5. category, detailed before primary', () => {
    it.each([
      ['RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_RENT'],
      ['RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY'],
      ['LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'], // a card Ledger can't see
      ['BANK_FEES', 'BANK_FEES_OTHER_BANK_FEES'],
      ['GENERAL_SERVICES', 'GENERAL_SERVICES_INSURANCE'],
      ['GOVERNMENT_AND_NON_PROFIT', 'GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT'],
      ['RENT_AND_UTILITIES', null],
    ])('%s / %s is a bill', (p, d) => {
      expect(cat(p, d)).toEqual({ bucket: 'bill', reason: 'bill-category', counts: true })
    })

    it('TRANSFER_OUT spend is suggested, and lands in Bills once confirmed', () => {
      expect(cat('TRANSFER_OUT', 'TRANSFER_OUT_ACCOUNT_TRANSFER')).toEqual({ bucket: 'suggested', reason: 'transfer-out', counts: false, confirmsAs: 'bill' })
    })

    it.each([
      ['FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE'],
      ['GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_SUPERSTORES'],
      ['TRANSPORTATION', 'TRANSPORTATION_GAS'],
    ])('%s / %s is suggested: the old detector false positives', (p, d) => {
      expect(cat(p, d)).toEqual({ bucket: 'suggested', reason: 'often-not-recurring', counts: false, confirmsAs: 'subscription' })
    })

    it('gas matches only on its detailed code: the rest of TRANSPORTATION is not singled out', () => {
      expect(cat('TRANSPORTATION', 'TRANSPORTATION_PUBLIC_TRANSIT')).toMatchObject({ reason: 'category-unlisted' })
      expect(cat('TRANSPORTATION', null)).toMatchObject({ reason: 'category-unlisted' })
    })

    it.each([
      ['ENTERTAINMENT', 'ENTERTAINMENT_TV_AND_MOVIES'],
      ['ENTERTAINMENT', 'ENTERTAINMENT_MUSIC_AND_AUDIO'],
      ['ENTERTAINMENT', 'ENTERTAINMENT_VIDEO_GAMES'],
      ['PERSONAL_CARE', 'PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS'],
      ['GENERAL_SERVICES', 'GENERAL_SERVICES_STORAGE'],
    ])('%s / %s is a subscription', (p, d) => {
      expect(cat(p, d)).toEqual({ bucket: 'subscription', reason: 'subscription-category', counts: true })
    })

    it.each([
      ['ENTERTAINMENT', 'ENTERTAINMENT_CASINOS_AND_GAMBLING'],
      ['GENERAL_SERVICES', 'GENERAL_SERVICES_OTHER_GENERAL_SERVICES'],
      ['MEDICAL', 'MEDICAL_PRIMARY_CARE'],
      ['OTHER', 'OTHER_OTHER'],
      ['ENTERTAINMENT', null], // a subscription primary alone isn't enough
      ['SOMETHING_NEW', 'SOMETHING_NEW_ENTIRELY'],
    ])('%s / %s, on neither list, is suggested', (p, d) => {
      expect(cat(p, d)).toEqual({ bucket: 'suggested', reason: 'category-unlisted', counts: false, confirmsAs: 'subscription' })
    })

    it('no category at all is suggested', () => {
      expect(cat(null, null)).toEqual({ bucket: 'suggested', reason: 'no-category', counts: false, confirmsAs: 'subscription' })
    })
  })

  describe('counts toward totals', () => {
    it('an inactive subscription or bill is listed (as ended) but does not count', () => {
      expect(sort({ isActive: false })).toEqual({ bucket: 'subscription', reason: 'subscription-category', counts: false })
      expect(sort({ isActive: false, pfcPrimary: 'RENT_AND_UTILITIES', pfcDetailed: 'RENT_AND_UTILITIES_RENT' })).toMatchObject({ bucket: 'bill', counts: false })
    })
    it('an UNKNOWN frequency, or one Plaid has added since, does not count', () => {
      expect(sort({ frequency: 'UNKNOWN' })).toEqual({ bucket: 'subscription', reason: 'subscription-category', counts: false })
      expect(sort({ frequency: 'FORTNIGHTLY_ISH' })).toMatchObject({ bucket: 'subscription', counts: false })
    })
    it.each(['WEEKLY', 'BIWEEKLY', 'SEMI_MONTHLY', 'MONTHLY', 'ANNUALLY'])('%s counts', (frequency) => {
      expect(sort({ frequency }).counts).toBe(true)
    })
  })
})

// ── resolution against our rows ───────────────────────────────────

const A = 'stream-sorting-user-a'
const B = 'stream-sorting-user-b'

async function wipe(id: string) {
  await prisma.recurringStream.deleteMany({ where: { userId: id } })
  await prisma.transaction.deleteMany({ where: { userId: id } })
  await prisma.account.deleteMany({ where: { userId: id } })
  await prisma.plaidItem.deleteMany({ where: { userId: id } })
  await prisma.user.deleteMany({ where: { id } })
}

/** A user with one checking account and three monthly streaming charges, ids `${id}-tx-1..3`. */
async function makeUser(id: string) {
  await prisma.user.create({ data: { id, email: `${id}@stream-sorting-test.local` } })
  const item = await prisma.plaidItem.create({ data: { userId: id, itemId: `${id}-item`, accessToken: encrypt(`access-${id}`), institutionName: 'Test Bank' } })
  const account = await prisma.account.create({ data: { userId: id, plaidItemId: item.id, plaidAccountId: `${id}-acct`, name: 'Checking', type: 'depository', isoCurrencyCode: 'USD' } })
  for (const n of [1, 2, 3]) {
    await prisma.transaction.create({
      data: {
        userId: id, accountId: account.id, plaidTransactionId: `${id}-tx-${n}`, date: new Date(Date.UTC(2026, 6 + n, 3)),
        amount: '9.99', name: 'STREAMING CO', categoryPrimary: 'ENTERTAINMENT', categoryDetailed: 'ENTERTAINMENT_TV_AND_MOVIES',
      },
    })
  }
  return item
}

async function addStream(userId: string, plaidItemId: string, streamId: string, plaidTransactionIds: string[]) {
  return prisma.recurringStream.create({
    data: {
      userId, plaidItemId, streamId, plaidAccountId: `${userId}-acct`, direction: 'outflow', description: 'STREAMING CO',
      pfcPrimary: 'ENTERTAINMENT', pfcDetailed: 'ENTERTAINMENT_TV_AND_MOVIES', frequency: 'MONTHLY', status: 'MATURE', isActive: true,
      firstDate: new Date(Date.UTC(2026, 7, 3)), lastDate: new Date(Date.UTC(2026, 9, 3)), lastAmount: '9.99',
      plaidTransactionIds, plaidUpdatedAt: new Date(),
    },
  })
}

describe('sortUserStreams', () => {
  let itemA: { id: string }
  let itemB: { id: string }
  beforeEach(async () => {
    await wipe(A); await wipe(B)
    itemA = await makeUser(A)
    itemB = await makeUser(B)
  })
  afterAll(async () => { await wipe(A); await wipe(B) })

  const sortOf = async (userId: string, streamId: string) =>
    (await sortUserStreams(userId)).find((s) => s.stream.streamId === streamId)!.sort

  it("resolves a stream's ids to its user's rows and sorts it with our verdicts", async () => {
    await addStream(A, itemA.id, 'FAKE-a-stream', [`${A}-tx-1`, `${A}-tx-2`, `${A}-tx-3`])
    expect(await sortOf(A, 'FAKE-a-stream')).toEqual({ bucket: 'subscription', reason: 'subscription-category', counts: true })
  })

  it("isolation: another user's transaction id resolves to nothing", async () => {
    expect((await resolveStreamRows(A, [`${B}-tx-1`])).size).toBe(0)
    // A stream of A's naming only B's transactions has no verdict: hidden, unmatched.
    await addStream(A, itemA.id, 'FAKE-a-names-b', [`${B}-tx-1`, `${B}-tx-2`, `${B}-tx-3`])
    expect(await sortOf(A, 'FAKE-a-names-b')).toMatchObject({ bucket: 'hidden', reason: 'unmatched' })
  })

  it("isolation: a stream naming its own and another user's ids resolves its own only", async () => {
    const resolved = await resolveStreamRows(A, [`${A}-tx-1`, `${B}-tx-1`])
    expect([...resolved.keys()]).toEqual([`${A}-tx-1`])
  })

  it('a soft-deleted row does not resolve', async () => {
    await prisma.transaction.updateMany({ where: { userId: A }, data: { deletedAt: new Date() } })
    expect((await resolveStreamRows(A, [`${A}-tx-1`])).size).toBe(0)
    await addStream(A, itemA.id, 'FAKE-a-deleted', [`${A}-tx-1`])
    expect(await sortOf(A, 'FAKE-a-deleted')).toMatchObject({ bucket: 'hidden', reason: 'unmatched' })
  })

  it("sorts only the user's own streams", async () => {
    await addStream(A, itemA.id, 'FAKE-a-stream', [`${A}-tx-1`])
    await addStream(B, itemB.id, 'FAKE-b-stream', [`${B}-tx-1`])
    expect((await sortUserStreams(A)).map((s) => s.stream.streamId)).toEqual(['FAKE-a-stream'])
  })
})

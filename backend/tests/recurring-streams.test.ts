// ─────────────────────────────────────────────────────────────────
//  RecurringStream (M7.6 PR 1): the table, its keys, its sign convention,
//  and every path that deletes the rows it hangs off. Nothing writes a
//  stream in the app yet; these tests insert them directly.
//
//  All ids, names and amounts are invented.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import request from 'supertest'
import { app, plaidClient } from '../src/app'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'
import { readFrequency, readStatus, signedAmount, streamColumns, type PlaidStream } from '../src/lib/recurringStreams'

const A = 'streams-test-user-a'
const B = 'streams-test-user-b'
const mock = (name: string) => (plaidClient as any)[name] as Mock

async function wipe(id: string) {
  await prisma.recurringStream.deleteMany({ where: { userId: id } })
  await prisma.transaction.deleteMany({ where: { userId: id } })
  await prisma.account.deleteMany({ where: { userId: id } })
  await prisma.plaidItem.deleteMany({ where: { userId: id } })
  await prisma.alert.deleteMany({ where: { userId: id } })
  await prisma.balanceSnapshot.deleteMany({ where: { userId: id } })
  await prisma.user.deleteMany({ where: { id } })
}

async function bank(userId: string, tag: string, opts: { institutionId?: string; mask?: string } = {}) {
  const item = await prisma.plaidItem.create({
    data: { userId, itemId: `${userId}-${tag}`, accessToken: encrypt(`access-${userId}-${tag}`), institutionId: opts.institutionId ?? `ins_${tag}`, institutionName: `${tag} Bank` },
  })
  const account = await prisma.account.create({
    data: { userId, plaidItemId: item.id, plaidAccountId: `${userId}-${tag}-acct`, name: 'Checking', mask: opts.mask ?? '0001', subtype: 'checking', type: 'depository', isoCurrencyCode: 'USD' },
  })
  return { item, account }
}

const plaidStream = (over: Partial<PlaidStream> = {}): PlaidStream => ({
  stream_id: 'FAKEstream000000000000000000000000001', account_id: 'FAKEacct', description: 'STREAMLET',
  merchant_name: 'Streamlet', personal_finance_category: { primary: 'ENTERTAINMENT', detailed: 'ENTERTAINMENT_TV_AND_MOVIES' },
  frequency: 'MONTHLY', status: 'MATURE', is_active: true, first_date: '2026-06-05', last_date: '2026-09-05',
  predicted_next_date: '2026-10-05', average_amount: { amount: 12.5, iso_currency_code: 'USD' },
  last_amount: { amount: 12.5, iso_currency_code: 'USD' }, transaction_ids: ['FAKEtx1'], ...over,
})

async function stream(userId: string, plaidItemId: string, streamId = 'FAKEstream-1') {
  return prisma.recurringStream.create({
    data: streamColumns(plaidStream({ stream_id: streamId }), { userId, plaidItemId, direction: 'outflow', plaidUpdatedAt: new Date() }),
  })
}

beforeEach(async () => {
  await wipe(A); await wipe(B)
  await prisma.user.create({ data: { id: A, email: `${A}@streams-test.local` } })
  await prisma.user.create({ data: { id: B, email: `${B}@streams-test.local` } })
})
afterAll(async () => { await wipe(A); await wipe(B) })

describe('amounts follow Transaction.amount: positive is money out', () => {
  // Plaid documents the sign for transactions, not for streams, so the stored
  // sign comes from the direction — whichever way Plaid sent it.
  it.each([
    ['outflow', 12.5, 1], ['outflow', -12.5, 1],
    ['inflow', 2400, -1], ['inflow', -2400, -1],
  ] as const)('%s stream sent as %d stores the sign of its transactions (%d)', (direction, sent, txSign) => {
    const cols = streamColumns(plaidStream({ last_amount: { amount: sent }, average_amount: { amount: sent } }),
      { userId: A, plaidItemId: 'x', direction, plaidUpdatedAt: new Date() })
    // Its last transaction, as plaidSync stores it: Plaid's own amount, unchanged.
    const lastTransactionAmount = direction === 'outflow' ? 12.5 : -2400
    expect(Math.sign(cols.lastAmount!)).toBe(Math.sign(lastTransactionAmount))
    expect(Math.sign(cols.lastAmount!)).toBe(txSign)
    expect(Math.sign(cols.averageAmount!)).toBe(txSign)
  })

  it('a missing amount is null, not zero', () => {
    expect(signedAmount(undefined, 'outflow')).toBeNull()
    expect(streamColumns(plaidStream({ last_amount: null, average_amount: {} }), { userId: A, plaidItemId: 'x', direction: 'outflow', plaidUpdatedAt: new Date() }))
      .toMatchObject({ lastAmount: null, averageAmount: null })
  })

  it('a stored stream and its last transaction agree in sign', async () => {
    const { item, account } = await bank(A, 'sign')
    await prisma.transaction.create({ data: { userId: A, accountId: account.id, plaidTransactionId: 'FAKEtx-sign', date: new Date(Date.UTC(2026, 8, 5)), amount: '12.50', name: 'STREAMLET' } })
    const s = await prisma.recurringStream.create({
      data: streamColumns(plaidStream({ last_amount: { amount: -12.5 }, transaction_ids: ['FAKEtx-sign'] }), { userId: A, plaidItemId: item.id, direction: 'outflow', plaidUpdatedAt: new Date() }),
    })
    const last = await prisma.transaction.findFirstOrThrow({ where: { userId: A, plaidTransactionId: { in: s.plaidTransactionIds } } })
    expect(Math.sign(Number(s.lastAmount))).toBe(Math.sign(Number(last.amount)))
  })
})

describe('reading Plaid open values', () => {
  it('maps unknown frequency and status to UNKNOWN, logging each value once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(readFrequency('MONTHLY')).toBe('MONTHLY')
    expect(readStatus('TOMBSTONED')).toBe('TOMBSTONED')
    expect(readFrequency('FORTNIGHTLY_FAKE')).toBe('UNKNOWN')
    expect(readFrequency('FORTNIGHTLY_FAKE')).toBe('UNKNOWN')
    expect(readStatus('PAUSED_FAKE')).toBe('UNKNOWN')
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})

describe('the database', () => {
  it("refuses a stream whose user doesn't own its Item", async () => {
    const { item } = await bank(A, 'owner')
    await expect(stream(B, item.id)).rejects.toThrow()
    expect(await prisma.recurringStream.count({ where: { plaidItemId: item.id } })).toBe(0)
  })

  it('refuses to delete a User or an Item that still has streams', async () => {
    const { item } = await bank(A, 'restrict')
    await stream(A, item.id)
    await expect(prisma.plaidItem.delete({ where: { id: item.id } })).rejects.toThrow()
    await prisma.account.deleteMany({ where: { userId: A } })
    await expect(prisma.user.delete({ where: { id: A } })).rejects.toThrow()
    expect(await prisma.recurringStream.count({ where: { userId: A } })).toBe(1)
  })

  it('a stream id is unique per Item, not globally', async () => {
    const one = await bank(A, 'u1'), two = await bank(A, 'u2')
    await stream(A, one.item.id, 'FAKEsame')
    await stream(A, two.item.id, 'FAKEsame')
    await expect(stream(A, one.item.id, 'FAKEsame')).rejects.toThrow()
  })
})

describe('deleting an Item deletes its streams', () => {
  it("unlink removes that Item's streams and leaves another Item's", async () => {
    const gone = await bank(A, 'gone'), kept = await bank(A, 'kept')
    await stream(A, gone.item.id, 'FAKEgone')
    const keptStream = await stream(A, kept.item.id, 'FAKEkept')
    const res = await request(app).delete(`/plaid-items/${gone.item.id}`).set('X-Test-User', A)
    expect(res.status).toBe(200)
    expect(await prisma.recurringStream.findMany({ where: { userId: A }, select: { id: true } })).toEqual([{ id: keptStream.id }])
  })

  it("the duplicate-link path's removal of a new Item removes its streams", async () => {
    const old = await bank(A, 'dup-old', { institutionId: 'ins_dup', mask: '4321' })
    mock('itemPublicTokenExchange').mockResolvedValueOnce({ data: { access_token: 'access-dup-new', item_id: `${A}-dup-new` } })
    mock('itemGet').mockResolvedValueOnce({ data: { item: { institution_id: 'ins_dup' } } })
    // While the new Item is stored, give it a stream, then answer with the same
    // account as the old Item: the after-exchange check removes the new one.
    mock('accountsGet').mockImplementationOnce(async () => {
      const fresh = await prisma.plaidItem.findUniqueOrThrow({ where: { itemId: `${A}-dup-new` } })
      await stream(A, fresh.id, 'FAKEdup')
      return { data: { accounts: [{ account_id: `${A}-dup-new-acct`, name: 'Checking', official_name: null, mask: '4321', type: 'depository', subtype: 'checking', balances: { current: 1, available: 1, iso_currency_code: 'USD' } }] } }
    })
    const res = await request(app).post('/exchange_public_token').set('X-Test-User', A).send({ public_token: 'public-test' })
    expect(res.status).toBe(409)
    expect(await prisma.plaidItem.findUnique({ where: { itemId: `${A}-dup-new` } })).toBeNull()
    expect(await prisma.recurringStream.count({ where: { userId: A } })).toBe(0)
    expect(await prisma.plaidItem.findUnique({ where: { id: old.item.id } })).not.toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────
//  The recurring-streams backfill's write half (scripts/lib/recurring-backfill):
//  applies already-fetched streams for many Items in one transaction, through
//  the refresh's own apply, and rolls back unless the count matches --expect
//  and nothing outside RecurringStream changed. All ids are invented.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'
import { RecurringBackfillRefused, runRecurringBackfill } from '../scripts/lib/recurring-backfill'
import type { FetchedStreams } from '../src/services/recurringStreams.service'
import type { PlaidStream } from '../src/lib/recurringStreams'

const USERS = ['rbf-test-user-a', 'rbf-test-user-b']
const items: Record<string, string> = {}

const stream = (userId: string, id: string): PlaidStream => ({
  stream_id: `FAKE-${id}`, account_id: `${userId}-acct`, description: id.toUpperCase(), frequency: 'MONTHLY', status: 'MATURE',
  is_active: true, first_date: '2026-06-05', last_date: '2026-09-05', last_amount: { amount: 9 }, transaction_ids: [],
})
const fetchedFor = (userId: string, ids: string[]): FetchedStreams => ({
  plaidItemId: items[userId], userId, plaidUpdatedAt: new Date(),
  streams: ids.map((id) => ({ direction: 'outflow' as const, stream: stream(userId, id) })),
})
const streamCount = () => prisma.recurringStream.count({ where: { userId: { in: USERS } } })

async function cleanup() {
  for (const id of USERS) {
    await prisma.recurringStream.deleteMany({ where: { userId: id } })
    await prisma.budget.deleteMany({ where: { userId: id } })
    await prisma.account.deleteMany({ where: { userId: id } })
    await prisma.plaidItem.deleteMany({ where: { userId: id } })
    await prisma.user.deleteMany({ where: { id } })
  }
}

beforeEach(async () => {
  await cleanup()
  for (const id of USERS) {
    await prisma.user.create({ data: { id, email: `${id}@rbf-test.local` } })
    const item = await prisma.plaidItem.create({ data: { userId: id, itemId: `${id}-item`, accessToken: encrypt(`access-${id}`), institutionName: 'Test Bank' } })
    items[id] = item.id
    await prisma.account.create({ data: { userId: id, plaidItemId: item.id, plaidAccountId: `${id}-acct`, name: 'Checking', type: 'depository', isoCurrencyCode: 'USD' } })
    await prisma.budget.create({ data: { userId: id, category: 'Shopping', monthlyLimit: '100.00' } })
  }
})
afterAll(cleanup)

const all = () => [fetchedFor(USERS[0], ['a1', 'a2']), fetchedFor(USERS[1], ['b1'])]

describe('runRecurringBackfill', () => {
  it('writes every Item in one transaction when the count matches', async () => {
    expect(await runRecurringBackfill(prisma, all(), 3)).toEqual({ written: 3, removed: 0 })
    expect(await streamCount()).toBe(3)
  })

  it('rolls everything back when the count differs from --expect', async () => {
    const run = runRecurringBackfill(prisma, all(), 2)
    await expect(run).rejects.toBeInstanceOf(RecurringBackfillRefused)
    await expect(run).rejects.toThrow('--expect 2, but 3 stream(s) would be written')
    expect(await streamCount()).toBe(0)
  })

  it('rolls everything back when a row outside RecurringStream changes', async () => {
    const run = runRecurringBackfill(prisma, all(), 3, {
      insideTransaction: (tx) => tx.budget.updateMany({ where: { userId: USERS[1] }, data: { monthlyLimit: '101.00' } }),
    })
    await expect(run).rejects.toThrow(/rows outside RecurringStream changed \(Budget\)/)
    expect(await streamCount()).toBe(0)
    expect(Number((await prisma.budget.findFirstOrThrow({ where: { userId: USERS[1] } })).monthlyLimit)).toBe(100)
  })
})

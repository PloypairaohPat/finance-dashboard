// ─────────────────────────────────────────────────────────────────
//  plaidSync writes one sync as one transaction: the rows and the cursor
//  commit together or not at all. Pages are all fetched first, so the
//  transaction never waits on Plaid. All ids and amounts are invented.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { PlaidApi } from 'plaid'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'
import { syncTransactions } from '../src/services/plaidSync'

const USER = 'plaid-sync-atomic-test-user'
const ACCOUNT = `${USER}-checking`
let itemId = ''

const tx = (id: string, over: Record<string, unknown> = {}) => ({
  transaction_id: `${USER}-${id}`, account_id: ACCOUNT, amount: 10, iso_currency_code: 'USD',
  date: '2026-01-10', name: id.toUpperCase(), merchant_name: null, pending: false,
  personal_finance_category: { primary: 'GENERAL_MERCHANDISE', detailed: 'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE' },
  merchant_entity_id: null, counterparties: [],
  ...over,
})

/** A client whose transactionsSync answers with `pages` in order. */
function client(pages: Array<{ added?: unknown[]; modified?: unknown[]; removed?: unknown[] }>) {
  const c = new PlaidApi() as any
  pages.forEach((p, i) =>
    c.transactionsSync.mockResolvedValueOnce({
      data: {
        added: [], modified: [], removed: [], ...p,
        has_more: i < pages.length - 1, next_cursor: `cursor-${i + 1}`,
      },
    }))
  return c as PlaidApi
}

const live = () => prisma.transaction.count({ where: { userId: USER, deletedAt: null } })
const cursor = async () => (await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemId } })).cursor

async function cleanup() {
  await prisma.alert.deleteMany({ where: { userId: USER } })
  await prisma.balanceSnapshot.deleteMany({ where: { userId: USER } })
  await prisma.transaction.deleteMany({ where: { userId: USER } })
  await prisma.account.deleteMany({ where: { userId: USER } })
  await prisma.plaidItem.deleteMany({ where: { userId: USER } })
  await prisma.user.deleteMany({ where: { id: USER } })
}

beforeEach(async () => {
  await cleanup()
  await prisma.user.create({ data: { id: USER, email: `${USER}@sync-test.local` } })
  const item = await prisma.plaidItem.create({
    data: { userId: USER, itemId: `${USER}-item`, accessToken: encrypt(`fake-token-${USER}`), institutionName: 'Test Bank', cursor: 'cursor-0' },
  })
  itemId = item.id
  await prisma.account.create({
    data: { userId: USER, plaidItemId: item.id, plaidAccountId: ACCOUNT, name: 'Checking', type: 'depository', isoCurrencyCode: 'USD' },
  })
})

afterAll(cleanup)

describe('plaidSync', () => {
  it('writes nothing, and keeps the old cursor, when any write in the sync fails', async () => {
    // Two good rows, then one Postgres will refuse (an amount that isn't a number).
    const c = client([{ added: [tx('a'), tx('b'), tx('bad', { amount: 'not-a-number' })] }])
    await expect(syncTransactions(c, itemId)).rejects.toThrow()
    expect(await live()).toBe(0)
    expect(await cursor()).toBe('cursor-0')
  })

  it('commits rows and cursor together across several pages', async () => {
    const c = client([{ added: [tx('p1')] }, { added: [tx('p2')] }, { added: [tx('p3')] }])
    await syncTransactions(c, itemId)
    expect(await live()).toBe(3)
    expect(await cursor()).toBe('cursor-3')
  })

  it('leaves exactly one live row when a pending charge posts', async () => {
    await syncTransactions(client([{ added: [tx('pending-1', { pending: true })] }]), itemId)
    await syncTransactions(client([{
      added: [tx('posted-1', { pending_transaction_id: `${USER}-pending-1`, date: '2026-01-12' })],
      removed: [{ transaction_id: `${USER}-pending-1` }],
    }]), itemId)
    const rows = await prisma.transaction.findMany({ where: { userId: USER, deletedAt: null } })
    expect(rows.map((r) => r.plaidTransactionId)).toEqual([`${USER}-posted-1`])
  })

  it('handles a first sync pulling full history inside the transaction timeout', async () => {
    // Two years of a busy account, in Plaid's 500-row pages.
    const N = 3000
    const all = Array.from({ length: N }, (_, i) =>
      tx(`h${i}`, { date: new Date(Date.UTC(2024, 9, 1) + (i % 730) * 86_400_000).toISOString().slice(0, 10) }))
    const pages = Array.from({ length: N / 500 }, (_, i) => ({ added: all.slice(i * 500, (i + 1) * 500) }))
    await syncTransactions(client(pages), itemId)
    expect(await live()).toBe(N)
    expect(await cursor()).toBe(`cursor-${N / 500}`)
  }, 300_000)
})

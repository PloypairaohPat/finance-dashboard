// ─────────────────────────────────────────────────────────────────
//  Unlinking a bank removes everything tied to it. It already deleted the
//  bank's transactions and accounts; it left that bank's net-worth snapshots
//  and any goal still pointing at one of its accounts. All ids are invented.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { app } from '../src/app'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'

const USER = 'unlink-gap-test-user'

async function cleanup() {
  await prisma.goal.deleteMany({ where: { userId: USER } })
  await prisma.balanceSnapshot.deleteMany({ where: { userId: USER } })
  await prisma.transaction.deleteMany({ where: { userId: USER } })
  await prisma.account.deleteMany({ where: { userId: USER } })
  await prisma.plaidItem.deleteMany({ where: { userId: USER } })
  await prisma.user.deleteMany({ where: { id: USER } })
}

async function bank(tag: string) {
  const item = await prisma.plaidItem.create({
    data: { userId: USER, itemId: `${USER}-${tag}`, accessToken: encrypt(`access-${tag}`), institutionId: `ins_${tag}`, institutionName: `${tag} Bank` },
  })
  const account = await prisma.account.create({
    data: { userId: USER, plaidItemId: item.id, plaidAccountId: `${USER}-${tag}-acct`, name: 'Checking', type: 'depository', isoCurrencyCode: 'USD' },
  })
  const snapshot = await prisma.balanceSnapshot.create({
    data: { userId: USER, accountId: account.plaidAccountId, accountName: 'Checking', accountType: 'depository', currentBalance: '10.00', date: new Date(Date.UTC(2026, 8, 30)) },
  })
  const goal = await prisma.goal.create({ data: { userId: USER, type: 'savings', name: `${tag} goal`, targetAmount: '100.00', accountId: account.id } })
  return { item, account, snapshot, goal }
}

beforeEach(async () => {
  await cleanup()
  await prisma.user.create({ data: { id: USER, email: `${USER}@unlink-test.local` } })
})
afterAll(cleanup)

describe('unlinking a bank', () => {
  it("deletes its snapshots and clears goals' links to its accounts, and leaves the other bank's alone", async () => {
    const gone = await bank('gone')
    const kept = await bank('kept')
    const res = await request(app).delete(`/plaid-items/${gone.item.id}`).set('X-Test-User', USER)
    expect(res.status).toBe(200)

    expect(await prisma.balanceSnapshot.findUnique({ where: { id: gone.snapshot.id } })).toBeNull()
    expect(await prisma.goal.findUniqueOrThrow({ where: { id: gone.goal.id } })).toMatchObject({ accountId: null })

    expect(await prisma.balanceSnapshot.findUnique({ where: { id: kept.snapshot.id } })).not.toBeNull()
    expect(await prisma.goal.findUniqueOrThrow({ where: { id: kept.goal.id } })).toMatchObject({ accountId: kept.account.id })
  })
})

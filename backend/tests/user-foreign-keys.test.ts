// ─────────────────────────────────────────────────────────────────
//  Budget, BalanceSnapshot, Alert and Goal each belong to a User row.
//
//  They used to carry a userId with no foreign key, so nothing stopped a row
//  outliving its user — and "delete my data" can't promise to remove what a
//  stray write can recreate. Now the database refuses an orphan.
//
//  The other half: no app path may write one of these before the User row
//  exists. Clerk signs a user in without creating it; it was created on the
//  first bank link or settings save. A budget or goal made before either
//  would now fail, so those paths ensure the User row first.
//
//  All ids are invented.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { app } from '../src/app'
import prisma from '../src/lib/prisma'

const NEW_USER = 'user-fk-test-brand-new'
const MISSING = 'user-fk-test-never-existed'

async function cleanup() {
  for (const id of [NEW_USER, MISSING]) {
    await prisma.alert.deleteMany({ where: { userId: id } })
    await prisma.budget.deleteMany({ where: { userId: id } })
    await prisma.goal.deleteMany({ where: { userId: id } })
    await prisma.balanceSnapshot.deleteMany({ where: { userId: id } })
    await prisma.user.deleteMany({ where: { id } })
  }
}

beforeEach(cleanup)
afterAll(cleanup)

describe('the database refuses a row whose user does not exist', () => {
  it.each([
    ['Budget', () => prisma.budget.create({ data: { userId: MISSING, category: 'Shopping', monthlyLimit: '100.00' } })],
    ['Goal', () => prisma.goal.create({ data: { userId: MISSING, type: 'savings', name: 'Orphan goal' } })],
    ['Alert', () => prisma.alert.create({ data: { userId: MISSING, kind: 'low_balance', fingerprint: 'fk-test', severity: 'medium', title: 't', body: 'b' } })],
    ['BalanceSnapshot', () => prisma.balanceSnapshot.create({
      data: { userId: MISSING, accountId: 'fk-test-acct', accountName: 'Checking', accountType: 'depository', currentBalance: '1.00', date: new Date() },
    })],
  ])('%s', async (_table, write) => {
    await expect(write()).rejects.toThrow()
  })
})

describe('a signed-in user with no User row yet (nothing linked, no settings saved)', () => {
  const as = () => ({ 'X-Test-User': NEW_USER })

  it('can create a budget', async () => {
    const res = await request(app).post('/budgets').set(as()).send({ category: 'Shopping', monthlyLimit: 100 })
    expect(res.status).toBeLessThan(300)
    expect(await prisma.budget.count({ where: { userId: NEW_USER } })).toBe(1)
  })

  it('can create a goal', async () => {
    const res = await request(app).post('/goals').set(as()).send({ type: 'savings', name: 'Rainy day', targetAmount: 500 })
    expect(res.status).toBeLessThan(300)
    expect(await prisma.goal.count({ where: { userId: NEW_USER } })).toBe(1)
  })

  it('can open the bell: no detector writes for a user with no data', async () => {
    const res = await request(app).get('/alerts').set(as())
    expect(res.status).toBe(200)
    expect(await prisma.alert.count({ where: { userId: NEW_USER } })).toBe(0)
  })
})

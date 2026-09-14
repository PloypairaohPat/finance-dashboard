// ─────────────────────────────────────────────────────────────────
//  tests/alerts-dismissal.test.ts — a dismissed alert must stay dismissed
//
//  GET /alerts runs every detector and upserts its results before reading.
//  If the upsert's update branch resets `dismissedAt`, any alert whose
//  condition still holds is un-dismissed by the very next fetch — so a
//  dismissal only lasts until the page loads again.
//
//  Uses the low_balance detector because its condition is fully controlled
//  by fixture data (a depository account under $100). Assertions key on the
//  alert's id, not its kind: low_balance's fingerprint embeds today's date,
//  so a run straddling UTC midnight can create a second row, and that must
//  not make this test pass or fail.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { app } from '../src/app'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'

const USER = 'alerts-dismissal-test-user'

async function cleanup(): Promise<void> {
  await prisma.transaction.deleteMany({ where: { userId: USER } })
  await prisma.account.deleteMany({ where: { userId: USER } })
  await prisma.plaidItem.deleteMany({ where: { userId: USER } })
  await prisma.alert.deleteMany({ where: { userId: USER } })
  await prisma.user.deleteMany({ where: { id: USER } })
}

describe('alert dismissal', () => {
  beforeAll(async () => {
    await cleanup()
    await prisma.user.create({ data: { id: USER, email: `${USER}@alerts-test.local` } })
    const item = await prisma.plaidItem.create({
      data: {
        userId: USER,
        itemId: `${USER}-item-1`,
        accessToken: encrypt(`fake-access-token-${USER}`),
        institutionId: `ins_${USER}`,
        institutionName: `${USER}-Test-Bank`,
      },
    })
    await prisma.account.create({
      data: {
        userId: USER,
        plaidItemId: item.id,
        plaidAccountId: `${USER}-acct-1`,
        name: `${USER}-Low-Checking`,
        type: 'depository',
        subtype: 'checking',
        currentBalance: '42.00',
        availableBalance: '42.00',
        isoCurrencyCode: 'USD',
      },
    })
  })

  afterAll(async () => {
    await cleanup()
  })

  it('a dismissed alert is not reopened by the next GET /alerts while its condition still holds', async () => {
    const first = await request(app).get('/alerts').set('X-Test-User', USER)
    expect(first.status).toBe(200)
    const lowBalance = (first.body as Array<{ id: string; kind: string }>).find((a) => a.kind === 'low_balance')
    expect(lowBalance, 'fixture should trigger a low_balance alert').toBeDefined()
    const alertId = lowBalance!.id

    const dismissed = await request(app).post(`/alerts/${alertId}/dismiss`).set('X-Test-User', USER)
    expect(dismissed.status).toBe(200)
    expect(dismissed.body).toMatchObject({ success: true })

    const afterDismiss = await prisma.alert.findUniqueOrThrow({ where: { id: alertId } })
    expect(afterDismiss.dismissedAt).not.toBeNull()

    // The account is still under $100, so the detector fires again here.
    const second = await request(app).get('/alerts').set('X-Test-User', USER)
    expect(second.status).toBe(200)
    const ids = (second.body as Array<{ id: string }>).map((a) => a.id)
    expect(ids, 'dismissed alert came back in the active list').not.toContain(alertId)

    const afterRefetch = await prisma.alert.findUniqueOrThrow({ where: { id: alertId } })
    expect(afterRefetch.dismissedAt, 'detector upsert cleared dismissedAt').not.toBeNull()
  })
})

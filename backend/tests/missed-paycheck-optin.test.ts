// ─────────────────────────────────────────────────────────────────
//  User.missedPaycheckAlerts, the opt-in (M7.6 PR 6a), and the settings API
//  that carries it (6b): off for everyone until they turn it on; GET says
//  whether there's a regular paycheck to watch, so the dialog can say plainly
//  when there isn't. All ids are invented.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { app } from '../src/app'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'

const USER = 'missed-paycheck-optin-test-user'
const LEGACY = 'missed-paycheck-optin-legacy-user'

async function wipe() {
  for (const id of [USER, LEGACY]) {
    await prisma.alert.deleteMany({ where: { userId: id } })
    await prisma.recurringStream.deleteMany({ where: { userId: id } })
    await prisma.plaidItem.deleteMany({ where: { userId: id } })
  }
  await prisma.user.deleteMany({ where: { id: { in: [USER, LEGACY] } } })
}
beforeEach(wipe)
afterAll(wipe)

const get = () => request(app).get('/user/settings').set('X-Test-User', USER)
const put = (body: object) => request(app).put('/user/settings').set('X-Test-User', USER).send(body)

describe('the column', () => {
  it('is off for a new user', async () => {
    const u = await prisma.user.create({ data: { id: USER, email: `${USER}@optin-test.local` } })
    expect(u.missedPaycheckAlerts).toBe(false)
  })

  it('is off for a user row written without it (existing users)', async () => {
    await prisma.$executeRaw`INSERT INTO "User" (id, email) VALUES (${LEGACY}, ${`${LEGACY}@optin-test.local`})`
    expect((await prisma.user.findUniqueOrThrow({ where: { id: LEGACY } })).missedPaycheckAlerts).toBe(false)
  })

  it('is never null', async () => {
    await prisma.user.create({ data: { id: USER, email: `${USER}@optin-test.local` } })
    await expect(prisma.$executeRaw`UPDATE "User" SET "missedPaycheckAlerts" = NULL WHERE id = ${USER}`).rejects.toThrow()
  })
})

describe('GET and PUT /user/settings', () => {
  beforeEach(async () => {
    await prisma.user.create({ data: { id: USER, email: `${USER}@optin-test.local` } })
  })

  it('GET carries the setting, off, and says no regular paycheck was found', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ periodStartDay: 1, paymentAppInflowsAreIncome: false, missedPaycheckAlerts: false, regularPaycheckFound: false })
  })

  it('PUT turns it on and off, and answers with what was stored', async () => {
    expect((await put({ missedPaycheckAlerts: true })).body).toMatchObject({ missedPaycheckAlerts: true })
    expect((await prisma.user.findUniqueOrThrow({ where: { id: USER } })).missedPaycheckAlerts).toBe(true)
    expect((await put({ missedPaycheckAlerts: false })).body).toMatchObject({ missedPaycheckAlerts: false })
  })

  it('PUT refuses anything but true or false, and changes nothing', async () => {
    for (const value of ['true', 1, null]) {
      expect((await put({ missedPaycheckAlerts: value })).status, String(value)).toBe(400)
    }
    expect((await prisma.user.findUniqueOrThrow({ where: { id: USER } })).missedPaycheckAlerts).toBe(false)
  })

  it('regularPaycheckFound is true only with a qualifying salary stream', async () => {
    const item = await prisma.plaidItem.create({ data: { userId: USER, itemId: `${USER}-item`, accessToken: encrypt('fake'), institutionName: 'Test Bank' } })
    const add = (detailed: string, status: string) => prisma.recurringStream.create({
      data: {
        userId: USER, plaidItemId: item.id, streamId: `FAKE-${detailed}-${status}`, plaidAccountId: `${USER}-acct`, direction: 'inflow',
        description: 'PAY', pfcPrimary: 'INCOME', pfcDetailed: detailed, frequency: 'BIWEEKLY', status, isActive: true,
        firstDate: new Date(), lastDate: new Date(), plaidTransactionIds: [], plaidUpdatedAt: new Date(),
      },
    })
    await add('INCOME_INTEREST_EARNED', 'MATURE')
    await add('INCOME_SALARY', 'EARLY_DETECTION')
    expect((await get()).body.regularPaycheckFound).toBe(false)
    await add('INCOME_SALARY', 'MATURE')
    expect((await get()).body.regularPaycheckFound).toBe(true)
  })

  it('demo mode: the demo message, and nothing changes', async () => {
    const demo = await prisma.user.findUnique({ where: { id: 'demo-user' }, select: { missedPaycheckAlerts: true } })
    const res = await request(app).put('/user/settings').set('X-Demo-Mode', '1').send({ missedPaycheckAlerts: !demo?.missedPaycheckAlerts })
    expect(res.body).toMatchObject({ demo: true, ok: false })
    expect(await prisma.user.findUnique({ where: { id: 'demo-user' }, select: { missedPaycheckAlerts: true } })).toEqual(demo)
  })
})

// ─────────────────────────────────────────────────────────────────
//  M7.6 PR 6a: User.missedPaycheckAlerts, the opt-in. Column only: off for
//  everyone, existing users included, and nothing reads or writes it yet —
//  the settings API and the bell behave exactly as before.
//  All ids are invented.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { app } from '../src/app'
import prisma from '../src/lib/prisma'
import { runDetectors } from '../src/services/alerts/dispatcher'

const USER = 'missed-paycheck-optin-test-user'
const LEGACY = 'missed-paycheck-optin-legacy-user'

async function wipe() {
  await prisma.alert.deleteMany({ where: { userId: { in: [USER, LEGACY] } } })
  await prisma.user.deleteMany({ where: { id: { in: [USER, LEGACY] } } })
}
beforeEach(wipe)
afterAll(wipe)

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

describe('nothing reads or writes it yet', () => {
  beforeEach(async () => {
    await prisma.user.create({ data: { id: USER, email: `${USER}@optin-test.local` } })
  })

  it('GET /user/settings answers exactly as before', async () => {
    const res = await request(app).get('/user/settings').set('X-Test-User', USER)
    expect(res.status).toBe(200)
    expect(Object.keys(res.body).sort()).toEqual(['paymentAppInflowsAreIncome', 'periodStartDay'])
  })

  it('PUT /user/settings does not accept it, and it stays off', async () => {
    const res = await request(app).put('/user/settings').set('X-Test-User', USER).send({ missedPaycheckAlerts: true })
    expect(res.status).toBe(400)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: USER } })).missedPaycheckAlerts).toBe(false)
  })

  it('the bell raises no missed_paycheck alert, even with it on', async () => {
    await prisma.user.update({ where: { id: USER }, data: { missedPaycheckAlerts: true } })
    await runDetectors(USER)
    expect(await prisma.alert.count({ where: { userId: USER, kind: 'missed_paycheck' } })).toBe(0)
  })
})

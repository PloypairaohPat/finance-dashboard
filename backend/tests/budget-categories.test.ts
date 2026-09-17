// ─────────────────────────────────────────────────────────────────
//  tests/budget-categories.test.ts — the dropdown mismatch, made visible
//
//  The Add-a-budget dropdown used to offer categories the API rejects, and hide
//  categories it accepts. Until M7.1 that failed silently: the form closed as
//  if the budget had been added. readWriteResult exposed it, and this file
//  pins the underlying facts so the fix is against a measured mismatch rather
//  than a remembered one:
//
//    - a category the old list offered is genuinely refused, and writes nothing
//    - categories the old list never offered are genuinely accepted
//    - GET /budgets/categories is exactly the set upsert accepts, which is what
//      makes it safe for the dropdown to be driven by it
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { app } from '../src/app'
import prisma from '../src/lib/prisma'
import { DISPLAY_CATEGORIES } from '../src/lib/categoryMap'

const USER = 'budget-category-test-user'

/** Offered by the old hardcoded dropdown, refused by the API. */
const OFFERED_BUT_REFUSED = ['Health & Fitness', 'Personal Care', 'Education']
/** Accepted by the API, but the old dropdown never offered them. */
const ACCEPTED_BUT_HIDDEN = ['Housing', 'Subscriptions', 'Debt']

const post = (category: string, monthlyLimit = 100) =>
  request(app).post('/budgets').set('X-Test-User', USER).send({ category, monthlyLimit })

async function cleanup() {
  await prisma.budget.deleteMany({ where: { userId: USER } })
  await prisma.user.deleteMany({ where: { id: USER } })
}

beforeAll(async () => {
  await cleanup()
  await prisma.user.create({ data: { id: USER, email: `${USER}@budget-test.local` } })
})

afterAll(cleanup)

describe('the dropdown mismatch is a real failure, not a cosmetic one', () => {
  it.each(OFFERED_BUT_REFUSED)('refuses %s, which the old dropdown offered', async (category) => {
    const res = await post(category)
    expect(res.status).not.toBe(200)
    expect(await prisma.budget.count({ where: { userId: USER, category } })).toBe(0)
  })

  it.each(ACCEPTED_BUT_HIDDEN)('accepts %s, which the old dropdown hid', async (category) => {
    const res = await post(category)
    expect(res.status).toBe(200)
    expect(await prisma.budget.count({ where: { userId: USER, category } })).toBe(1)
  })

  it('GET /budgets/categories is exactly the set the API accepts', async () => {
    const res = await request(app).get('/budgets/categories').set('X-Test-User', USER)
    expect(res.status).toBe(200)
    const offered = (res.body as Array<{ category: string }>).map((c) => c.category)
    // This equality is the whole reason the dropdown can be driven by this
    // endpoint: anything it offers, upsertBudget will accept.
    expect(offered).toEqual([...DISPLAY_CATEGORIES])
    for (const bad of OFFERED_BUT_REFUSED) expect(offered).not.toContain(bad)
    for (const good of ACCEPTED_BUT_HIDDEN) expect(offered).toContain(good)
  })
})

// ─────────────────────────────────────────────────────────────────
//  The entity-column backfill (scripts/lib/entity-backfill.ts): fills
//  only rows no new code has written (counterpartyEntities IS NULL), never a
//  row plaidSync has modified since, and refuses — rolling back — unless the
//  row count matches the dry run and nothing but the two columns changed.
//
//  All ids here are invented.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'
import { BackfillRefused, fingerprint, planBackfill, runBackfill } from '../scripts/lib/entity-backfill'

const USER = 'entity-backfill-test-user'

const gymRaw = {
  merchant_entity_id: 'ent-gym',
  counterparties: [{ name: 'Gym', type: 'merchant', entity_id: 'ent-gym' }, { name: 'Terminal', type: 'payment_terminal', entity_id: 'ent-term' }],
}

async function cleanup() {
  await prisma.transaction.deleteMany({ where: { userId: USER } })
  await prisma.account.deleteMany({ where: { userId: USER } })
  await prisma.plaidItem.deleteMany({ where: { userId: USER } })
  await prisma.user.deleteMany({ where: { id: USER } })
}

/** A row as it stood before the migration: columns NULL. */
async function legacyRow(accountId: string, key: string, rawJson: object | null) {
  const t = await prisma.transaction.create({
    data: {
      userId: USER, accountId, plaidTransactionId: `${USER}-${key}`, date: new Date(Date.UTC(2026, 0, 10)),
      amount: '10.00', name: key.toUpperCase(), ...(rawJson ? { rawJson } : {}),
    },
  })
  await prisma.$executeRaw`UPDATE "Transaction" SET "counterpartyEntities" = NULL, "merchantEntityId" = NULL WHERE id = ${t.id}`
  return t.id
}

const row = (id: string) =>
  prisma.$queryRaw<Array<{ merchantEntityId: string | null; counterpartyEntities: string[] | null; updatedAt: Date }>>`
    SELECT "merchantEntityId", "counterpartyEntities", "updatedAt" FROM "Transaction" WHERE id = ${id}`.then((r) => r[0])

const ids: Record<string, string> = {}

beforeEach(async () => {
  await cleanup()
  await prisma.user.create({ data: { id: USER, email: `${USER}@backfill-test.local` } })
  const item = await prisma.plaidItem.create({
    data: { userId: USER, itemId: `${USER}-item`, accessToken: encrypt(`fake-token-${USER}`), institutionName: 'Test Bank' },
  })
  const account = await prisma.account.create({
    data: { userId: USER, plaidItemId: item.id, plaidAccountId: `${USER}-acct`, name: 'Checking', type: 'depository' },
  })
  ids.gym = await legacyRow(account.id, 'gym', gymRaw)
  ids.plain = await legacyRow(account.id, 'plain', { counterparties: [] })
  ids.noRaw = await legacyRow(account.id, 'no-raw', null)
  // A row plaidSync modified after the migration: its columns hold NEWER ids
  // than its create-time rawJson. The backfill must leave it alone — including
  // the case where Plaid's latest payload had no ids at all.
  const modified = await prisma.transaction.create({
    data: {
      userId: USER, accountId: account.id, plaidTransactionId: `${USER}-modified`, date: new Date(Date.UTC(2026, 0, 11)),
      amount: '10.00', name: 'MODIFIED', rawJson: gymRaw, merchantEntityId: null, counterpartyEntities: [],
    },
  })
  ids.modified = modified.id
})

afterAll(cleanup)

describe('entity backfill', () => {
  it('plans only the rows no new code has written', async () => {
    const plan = await planBackfill(prisma)
    const mine = new Map(plan.rows.map((r) => [r.id, r]))
    expect(mine.get(ids.gym)).toEqual({ id: ids.gym, merchantEntityId: 'ent-gym', counterpartyEntities: ['merchant:ent-gym', 'payment_terminal:ent-term'] })
    expect(mine.get(ids.plain)).toEqual({ id: ids.plain, merchantEntityId: null, counterpartyEntities: [] })
    expect(mine.get(ids.noRaw)).toEqual({ id: ids.noRaw, merchantEntityId: null, counterpartyEntities: [] })
    expect(mine.has(ids.modified)).toBe(false)
  })

  it('fills them, leaves a modified row alone, and does not bump updatedAt', async () => {
    const before = { gym: await row(ids.gym), modified: await row(ids.modified) }
    const plan = await planBackfill(prisma)
    const result = await runBackfill(prisma, plan.rows.length)
    expect(result.updated).toBe(plan.rows.length)

    expect(await row(ids.gym)).toEqual({
      merchantEntityId: 'ent-gym', counterpartyEntities: ['merchant:ent-gym', 'payment_terminal:ent-term'], updatedAt: before.gym.updatedAt,
    })
    expect(await row(ids.plain)).toMatchObject({ merchantEntityId: null, counterpartyEntities: [] })
    expect(await row(ids.noRaw)).toMatchObject({ merchantEntityId: null, counterpartyEntities: [] })
    expect(await row(ids.modified)).toEqual(before.modified)

    // Idempotent: nothing left to fill.
    expect((await planBackfill(prisma)).rows).toHaveLength(0)
    expect((await runBackfill(prisma, 0)).updated).toBe(0)
  })

  it('refuses, writing nothing, when the count differs from the dry run', async () => {
    const plan = await planBackfill(prisma)
    for (const wrong of [plan.rows.length - 1, plan.rows.length + 1]) {
      const refusal = runBackfill(prisma, wrong)
      await expect(refusal).rejects.toBeInstanceOf(BackfillRefused)
      // Expected against found, and a sync as one possible cause rather than the cause.
      await expect(refusal).rejects.toThrow(`--expect ${wrong}, but ${plan.rows.length} row(s) need filling`)
      await expect(refusal).rejects.toThrow(/Either the figure passed is not the dry run's, or rows changed/)
      expect(await row(ids.gym)).toMatchObject({ merchantEntityId: null, counterpartyEntities: null })
    }
  })

  it('fingerprints every column except the two it fills', async () => {
    const start = await fingerprint(prisma)
    await prisma.$executeRaw`UPDATE "Transaction" SET "merchantEntityId" = 'x', "counterpartyEntities" = ARRAY['merchant:x'] WHERE id = ${ids.plain}`
    expect(await fingerprint(prisma)).toEqual(start)
    await prisma.$executeRaw`UPDATE "Transaction" SET notes = 'changed' WHERE id = ${ids.plain}`
    expect((await fingerprint(prisma)).hash).not.toBe(start.hash)
  })
})

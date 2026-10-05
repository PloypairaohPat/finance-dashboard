// ─────────────────────────────────────────────────────────────────
//  Plaid's entity ids on Transaction (merchantEntityId,
//  counterpartyEntities): what entityColumns extracts, and that plaidSync
//  writes them on create, on a re-delivered add, and on modify — while
//  rawJson stays exactly as it was created.
//
//  All ids here are invented.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaidApi } from 'plaid'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'
import { entityColumns } from '../src/lib/entityColumns'
import { syncTransactions } from '../src/services/plaidSync'

describe('entityColumns', () => {
  it('copies merchant_entity_id and every counterparty that has an entity id, in order', () => {
    expect(entityColumns({
      merchant_entity_id: 'ent-gym',
      counterparties: [
        { name: 'Gym', type: 'merchant', entity_id: 'ent-gym' },
        { name: 'No id', type: 'merchant' },
        { name: 'Terminal', type: 'PAYMENT_TERMINAL', entity_id: 'ent-terminal' },
      ],
    })).toEqual({
      merchantEntityId: 'ent-gym',
      counterpartyEntities: ['merchant:ent-gym', 'payment_terminal:ent-terminal'],
    })
  })

  it('is empty, not an error, for anything rawJson might hold', () => {
    const empty = { merchantEntityId: null, counterpartyEntities: [] }
    for (const raw of [null, undefined, {}, { counterparties: null }, { counterparties: 'x' }, { merchant_entity_id: '' }, { merchant_entity_id: 7 }]) {
      expect(entityColumns(raw as any), JSON.stringify(raw)).toEqual(empty)
    }
    expect(entityColumns({ counterparties: [null, { entity_id: 'ent-x' }] })).toEqual({
      merchantEntityId: null, counterpartyEntities: ['unknown:ent-x'],
    })
  })
})

const USER = 'entity-columns-test-user'
const ACCOUNT = `${USER}-checking`
let itemId = ''

const plaidTx = (id: string, over: Record<string, unknown> = {}) => ({
  transaction_id: `${USER}-${id}`, account_id: ACCOUNT, amount: 12.5, iso_currency_code: 'USD',
  date: '2026-01-10', name: id.toUpperCase(), merchant_name: id, pending: false,
  personal_finance_category: { primary: 'GENERAL_SERVICES', detailed: 'GENERAL_SERVICES_OTHER_GENERAL_SERVICES' },
  merchant_entity_id: null, counterparties: [],
  ...over,
})

/** One sync, with Plaid answering `page` once. */
async function syncWith(page: { added?: unknown[]; modified?: unknown[]; removed?: unknown[] }) {
  const client = new PlaidApi() as any
  client.transactionsSync.mockResolvedValueOnce({
    data: { added: [], modified: [], removed: [], ...page, has_more: false, next_cursor: 'c' },
  })
  await syncTransactions(client as PlaidApi, itemId)
}

const stored = (id: string) =>
  prisma.transaction.findUniqueOrThrow({ where: { plaidTransactionId: `${USER}-${id}` } })

async function cleanup() {
  await prisma.alert.deleteMany({ where: { userId: USER } })
  await prisma.balanceSnapshot.deleteMany({ where: { userId: USER } })
  await prisma.transaction.deleteMany({ where: { userId: USER } })
  await prisma.account.deleteMany({ where: { userId: USER } })
  await prisma.plaidItem.deleteMany({ where: { userId: USER } })
  await prisma.user.deleteMany({ where: { id: USER } })
}

beforeAll(async () => {
  await cleanup()
  await prisma.user.create({ data: { id: USER, email: `${USER}@entity-test.local` } })
  const item = await prisma.plaidItem.create({
    data: { userId: USER, itemId: `${USER}-item`, accessToken: encrypt(`fake-token-${USER}`), institutionName: 'Test Bank' },
  })
  itemId = item.id
  await prisma.account.create({
    data: {
      userId: USER, plaidItemId: item.id, plaidAccountId: ACCOUNT, name: 'Checking',
      type: 'depository', subtype: 'checking', currentBalance: '1000.00', isoCurrencyCode: 'USD',
    },
  })
})

afterAll(cleanup)

describe('plaidSync writes the entity columns', () => {
  it('on create', async () => {
    await syncWith({
      added: [
        plaidTx('gym', {
          merchant_entity_id: 'ent-gym',
          counterparties: [{ name: 'Gym', type: 'merchant', entity_id: 'ent-gym' }],
        }),
        plaidTx('plain'),
      ],
    })
    expect(await stored('gym')).toMatchObject({ merchantEntityId: 'ent-gym', counterpartyEntities: ['merchant:ent-gym'] })
    expect(await stored('plain')).toMatchObject({ merchantEntityId: null, counterpartyEntities: [] })
  })

  it('when Plaid delivers an add for a row we already have', async () => {
    await syncWith({
      added: [plaidTx('plain', {
        merchant_entity_id: 'ent-plain',
        counterparties: [{ name: 'Plain', type: 'merchant', entity_id: 'ent-plain' }],
      })],
    })
    expect(await stored('plain')).toMatchObject({ merchantEntityId: 'ent-plain', counterpartyEntities: ['merchant:ent-plain'] })
  })

  it('on modify, from the modified payload, without touching rawJson', async () => {
    const before = await stored('gym')
    await syncWith({
      modified: [plaidTx('gym', {
        merchant_entity_id: 'ent-gym-2',
        counterparties: [
          { name: 'Gym', type: 'merchant', entity_id: 'ent-gym-2' },
          { name: 'Terminal', type: 'payment_terminal', entity_id: 'ent-terminal' },
        ],
      })],
    })
    const after = await stored('gym')
    expect(after).toMatchObject({
      merchantEntityId: 'ent-gym-2',
      counterpartyEntities: ['merchant:ent-gym-2', 'payment_terminal:ent-terminal'],
    })
    // The raw layer is immutable: rawJson is still the payload the row was created from.
    expect(after.rawJson).toEqual(before.rawJson)
  })

  it('clears them when Plaid drops the ids', async () => {
    await syncWith({ modified: [plaidTx('gym')] })
    expect(await stored('gym')).toMatchObject({ merchantEntityId: null, counterpartyEntities: [] })
  })
})

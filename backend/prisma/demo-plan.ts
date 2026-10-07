// ─────────────────────────────────────────────────────────────────
//  demo-plan.ts — every row the demo reseed creates, built from the dataset
//  before anything connects. A module of its own so a test can build the
//  same plan the seed writes (seed-demo.ts runs on import): the test writes
//  it under its own user and checks the app's reading of it.
// ─────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import {
  DEMO_BUDGETS,
  DEMO_USER_ID,
  MONTHS_OF_HISTORY,
  primaryOf,
  toRawJson,
  type DemoDataset,
  type DemoTransaction,
} from './demo-dataset'
import { entityColumns } from '../src/lib/entityColumns'

const CURRENCY = 'USD'
const money = (n: number) => n.toFixed(2)
export const SENTINEL_TOKEN = 'DEMO-NO-TOKEN'

function mulberry32(seed: number) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── the plan: every row the rebuild will create, built before connecting ──

export interface Plan {
  dataset: DemoDataset
  plaidItem: Prisma.PlaidItemCreateManyInput[]
  account: Prisma.AccountCreateManyInput[]
  budget: Prisma.BudgetCreateManyInput[]
  balanceSnapshot: Prisma.BalanceSnapshotCreateManyInput[]
  goal: Prisma.GoalCreateManyInput[]
  transaction: Prisma.TransactionCreateManyInput[]
  recurringStream: Prisma.RecurringStreamCreateManyInput[]
  subscriptionMark: Prisma.SubscriptionMarkCreateManyInput[]
}

/**
 * Ids are generated here rather than by the database, so every table can be
 * written with ONE createMany: an account needs its item's id, a transaction
 * its account's, and createMany returns no ids.
 */
export function buildPlan(dataset: DemoDataset, userId: string = DEMO_USER_ID): Plan {
  const now = dataset.now

  const itemId = new Map<string, string>()
  const plaidItem = dataset.items.map((item) => {
    const id = randomUUID()
    itemId.set(item.key, id)
    return {
      id,
      userId,
      itemId: item.itemId,
      // Plaintext sentinel, deliberately: the demo path never syncs, and an
      // encrypted value would break local seeding, whose ENCRYPTION_KEY is an
      // invalid placeholder on purpose.
      accessToken: SENTINEL_TOKEN,
      institutionId: item.institutionId,
      institutionName: item.institutionName,
      // As of the build: the missed-paycheck alert judges a payday only on data
      // current past its deadline, and the demo never syncs.
      lastSyncedAt: now,
      streamsRefreshedAt: now,
    }
  })

  const accountId = new Map<string, string>()
  const plaidAccountId = new Map<string, string>()
  const account = dataset.accounts.map((a) => {
    const id = randomUUID()
    accountId.set(a.key, id)
    plaidAccountId.set(a.key, a.plaidAccountId)
    return {
      id,
      userId,
      plaidItemId: itemId.get(a.itemKey)!,
      plaidAccountId: a.plaidAccountId,
      name: a.name,
      officialName: a.officialName,
      type: a.type,
      subtype: a.subtype,
      mask: a.mask,
      currentBalance: a.currentBalance,
      availableBalance: a.availableBalance,
      isoCurrencyCode: CURRENCY,
    }
  })

  const transactionId = new Map<string, string>()
  const transaction = dataset.transactions.map((t: DemoTransaction) => {
    const raw = toRawJson(t, plaidAccountId.get(t.accountKey)!)
    const id = randomUUID()
    transactionId.set(t.plaidTransactionId, id)
    return {
      id,
      userId,
      accountId: accountId.get(t.accountKey)!,
      plaidTransactionId: t.plaidTransactionId,
      date: new Date(`${t.date}T00:00:00.000Z`),
      amount: money(t.amount),
      name: t.name,
      cleanName: t.merchantName ?? t.name,
      merchantName: t.merchantName,
      categoryPrimary: t.primary,
      categoryDetailed: t.detailed,
      isoCurrencyCode: CURRENCY,
      pending: t.pending,
      // Through the same function plaidSync uses, so demo rows can't disagree with their rawJson.
      ...entityColumns(raw),
      rawJson: raw as Prisma.InputJsonValue,
    }
  })

  // Budgets are stored under DISPLAY names, which is what fetchBudgetsWithSpend looks up.
  const budget = DEMO_BUDGETS.map((b) => ({ userId, category: b.category, monthlyLimit: b.monthlyLimit }))

  // Monthly balance snapshots (the net-worth trend), UTC month ends.
  const rnd = mulberry32(20260825)
  const between = (min: number, max: number) => min + rnd() * (max - min)
  const balanceSnapshot: Prisma.BalanceSnapshotCreateManyInput[] = []
  for (let back = MONTHS_OF_HISTORY; back >= 0; back--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back + 1, 0))
    const step = MONTHS_OF_HISTORY - back
    const mk = (key: string, name: string, type: string, bal: number) =>
      balanceSnapshot.push({
        userId,
        accountId: accountId.get(key)!,
        accountName: name,
        accountType: type,
        currentBalance: money(bal),
        availableBalance: null,
        isoCurrencyCode: CURRENCY,
        date: d,
      })
    mk('checking', 'Everyday Checking', 'depository', between(3600, 4600))
    mk('savings', 'High-Yield Savings', 'depository', 9000 + step * 1240)
    mk('card', 'Rewards Card', 'credit', between(1000, 1850))
    mk('nwChecking', 'Northwind Checking', 'depository', between(2200, 2900))
  }

  const goal: Prisma.GoalCreateManyInput[] = [
    {
      userId, type: 'savings', name: 'Emergency Fund',
      targetAmount: '20000.00', startAmount: '9000.00',
      deadline: new Date(Date.UTC(now.getUTCFullYear(), 11, 31)),
    },
    {
      userId, type: 'debt_payoff', name: 'Pay off Rewards Card',
      targetAmount: '0.00', startAmount: '1850.00', accountId: accountId.get('card')!,
    },
  ]

  // Plaid's recurring streams over the demo's own charges (M7.6 PR 5).
  const itemOfAccount = new Map(dataset.accounts.map((a) => [a.key, a.itemKey]))
  const txByPlaidId = new Map(dataset.transactions.map((t) => [t.plaidTransactionId, t]))
  const recurringStream: Prisma.RecurringStreamCreateManyInput[] = dataset.streams.map((st) => {
    const charges = st.txIds.map((id) => {
      const t = txByPlaidId.get(id)
      if (!t) throw new Error(`the demo stream ${st.streamId} names ${id}, which the dataset doesn't contain`)
      return t
    })
    const amounts = charges.map((t) => t.amount)
    const day = (d: string) => new Date(`${d}T00:00:00.000Z`)
    return {
      userId,
      plaidItemId: itemId.get(itemOfAccount.get(st.accountKey)!)!,
      streamId: st.streamId,
      plaidAccountId: plaidAccountId.get(st.accountKey)!,
      direction: st.direction,
      description: st.description,
      merchantName: st.merchantName,
      pfcPrimary: primaryOf(st.detailed),
      pfcDetailed: st.detailed,
      frequency: st.frequency,
      status: st.status,
      isActive: st.isActive,
      firstDate: day(charges[0].date),
      lastDate: day(charges[charges.length - 1].date),
      predictedNextDate: st.predictedNextDate ? day(st.predictedNextDate) : null,
      // Transaction.amount's sign, which the charges already carry: out positive, in negative.
      averageAmount: money(amounts.reduce((a, b) => a + b, 0) / amounts.length),
      lastAmount: money(amounts[amounts.length - 1]),
      isoCurrencyCode: CURRENCY,
      plaidTransactionIds: st.txIds,
      plaidUpdatedAt: now,
    }
  })

  // Demo visitors can't confirm or dismiss (demo mode is read-only), so the seed does.
  const subscriptionMark = dataset.verdicts.map(({ plaidTransactionId, kind }) => {
    const anchor = transactionId.get(plaidTransactionId)
    if (!anchor) throw new Error(`the demo has a verdict on ${plaidTransactionId}, which the dataset doesn't contain`)
    return { userId, transactionId: anchor, kind }
  })

  return { dataset, plaidItem, account, budget, balanceSnapshot, goal, transaction, recurringStream, subscriptionMark }
}

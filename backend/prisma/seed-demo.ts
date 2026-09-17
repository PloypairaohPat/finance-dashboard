/**
 * seed-demo.ts — write the demo user's data into a LOCAL database.
 *
 * The data itself lives in prisma/demo-dataset.ts as a pure function, together
 * with the manifest of what the M7.3 classifier must decide about every row.
 * This file is only the writer: guard, wipe, insert, report.
 *
 * Safety:
 *   - Refuses any DATABASE_URL that is not localhost. The old version loaded
 *     backend/.env via `import 'dotenv/config'`, so a bare `npx tsx
 *     prisma/seed-demo.ts` pointed at PRODUCTION. It no longer loads any env
 *     file: the URL has to come from the environment, and it has to be local.
 *   - Every row is scoped to DEMO_USER_ID. Nothing else is read or written.
 *   - Idempotent: re-running wipes ONLY the demo user's data, then rebuilds it.
 *   - No Plaid calls.
 *
 * Run:
 *   cd backend && npm run db:dev:seed
 *
 * Reseeding the PRODUCTION demo is deliberately not possible from here. The
 * extended seed reproduces the §7 mechanisms (transfers, card payments,
 * payment-app flows) that the current endpoints still miscount, so the public
 * demo should only be reseeded once the classifier lands.
 */
import { PrismaClient, Prisma } from '@prisma/client'
import {
  DEMO_BUDGETS,
  DEMO_USER_ID,
  MONTHS_OF_HISTORY,
  buildDemoDataset,
  toRawJson,
  type DemoTransaction,
} from './demo-dataset'

export { DEMO_USER_ID }

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function assertLocalDatabase(): void {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error(
      '\n[seed-demo] REFUSING TO RUN: DATABASE_URL is not set.\n' +
        'Run this through `npm run db:dev:seed`, which loads backend/.env.dev.\n',
    )
    process.exit(1)
  }
  let host = ''
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    console.error('\n[seed-demo] REFUSING TO RUN: DATABASE_URL is not a valid URL.\n')
    process.exit(1)
  }
  if (!LOCAL_HOSTNAMES.has(host)) {
    console.error(
      `\n[seed-demo] REFUSING TO RUN: DATABASE_URL host "${host}" is not local.\n` +
        'The demo seed deletes and rewrites rows; it may only ever target the local\n' +
        'dev database. Start it with "npm run db:dev:up" and use "npm run db:dev:seed".\n',
    )
    process.exit(1)
  }
  console.log(`[seed-demo] target: ${host} — local, OK`)
}

const CURRENCY = 'USD'
const money = (n: number) => n.toFixed(2)

function mulberry32(seed: number) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function summarise(transactions: DemoTransaction[]): string {
  const byKind: Record<string, number> = {}
  let decisionTagged = 0
  for (const t of transactions) {
    byKind[t.expected.kind] = (byKind[t.expected.kind] ?? 0) + 1
    if (t.decisions.length > 0) decisionTagged++
  }
  const kinds = Object.entries(byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(', ')
  return `${kinds}\n  rows whose expectation depends on a pending decision: ${decisionTagged}`
}

async function main() {
  assertLocalDatabase()
  const prisma = new PrismaClient()
  const now = new Date()
  const dataset = buildDemoDataset(now)

  console.log(`Seeding demo user "${DEMO_USER_ID}"…`)

  try {
    // 1) Wipe existing demo data (FK-safe order), scoped strictly to the demo user.
    await prisma.$transaction([
      prisma.transaction.deleteMany({ where: { userId: DEMO_USER_ID } }),
      prisma.account.deleteMany({ where: { userId: DEMO_USER_ID } }),
      prisma.plaidItem.deleteMany({ where: { userId: DEMO_USER_ID } }),
      prisma.budget.deleteMany({ where: { userId: DEMO_USER_ID } }),
      prisma.balanceSnapshot.deleteMany({ where: { userId: DEMO_USER_ID } }),
      prisma.alert.deleteMany({ where: { userId: DEMO_USER_ID } }),
      prisma.goal.deleteMany({ where: { userId: DEMO_USER_ID } }),
    ])

    // 2) Demo user — calendar months, like the default.
    await prisma.user.upsert({
      where: { id: DEMO_USER_ID },
      update: { periodStartDay: dataset.startDay },
      create: { id: DEMO_USER_ID, email: 'demo@ledger.app', periodStartDay: dataset.startDay },
    })

    // 3) Items. accessToken is a sentinel — the demo path never syncs.
    const itemIds = new Map<string, string>()
    for (const item of dataset.items) {
      const row = await prisma.plaidItem.create({
        data: {
          userId: DEMO_USER_ID,
          itemId: item.itemId,
          accessToken: 'DEMO-NO-TOKEN',
          institutionId: item.institutionId,
          institutionName: item.institutionName,
        },
      })
      itemIds.set(item.key, row.id)
    }

    // 4) Accounts
    const accountIds = new Map<string, string>()
    const plaidAccountIds = new Map<string, string>()
    for (const account of dataset.accounts) {
      const row = await prisma.account.create({
        data: {
          userId: DEMO_USER_ID,
          plaidItemId: itemIds.get(account.itemKey)!,
          plaidAccountId: account.plaidAccountId,
          name: account.name,
          officialName: account.officialName,
          type: account.type,
          subtype: account.subtype,
          mask: account.mask,
          currentBalance: account.currentBalance,
          availableBalance: account.availableBalance,
          isoCurrencyCode: CURRENCY,
        },
      })
      accountIds.set(account.key, row.id)
      plaidAccountIds.set(account.key, account.plaidAccountId)
    }

    // 5) Transactions, with the rawJson the classifier reads.
    const txData: Prisma.TransactionCreateManyInput[] = dataset.transactions.map((t) => ({
      userId: DEMO_USER_ID,
      accountId: accountIds.get(t.accountKey)!,
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
      rawJson: toRawJson(t, plaidAccountIds.get(t.accountKey)!) as Prisma.InputJsonValue,
    }))
    await prisma.transaction.createMany({ data: txData })

    // 6) Budgets — stored under DISPLAY names, which is what fetchBudgetsWithSpend
    //    looks up. Stored under Plaid codes (as before) they always showed $0.
    await prisma.budget.createMany({
      data: DEMO_BUDGETS.map((b) => ({
        userId: DEMO_USER_ID,
        category: b.category,
        monthlyLimit: b.monthlyLimit,
      })),
    })

    // 7) Monthly balance snapshots (drives the net-worth trend), UTC month ends.
    const rnd = mulberry32(20260825)
    const between = (min: number, max: number) => min + rnd() * (max - min)
    const snaps: Prisma.BalanceSnapshotCreateManyInput[] = []
    for (let back = MONTHS_OF_HISTORY; back >= 0; back--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back + 1, 0))
      const step = MONTHS_OF_HISTORY - back
      const mk = (key: string, name: string, type: string, bal: number, avail?: number) =>
        snaps.push({
          userId: DEMO_USER_ID,
          accountId: accountIds.get(key)!,
          accountName: name,
          accountType: type,
          currentBalance: money(bal),
          availableBalance: avail != null ? money(avail) : null,
          isoCurrencyCode: CURRENCY,
          date: d,
        })
      mk('checking', 'Everyday Checking', 'depository', between(3600, 4600))
      mk('savings', 'High-Yield Savings', 'depository', 9000 + step * 1240)
      mk('card', 'Rewards Card', 'credit', between(1000, 1850))
      mk('nwChecking', 'Northwind Checking', 'depository', between(2200, 2900))
    }
    await prisma.balanceSnapshot.createMany({ data: snaps, skipDuplicates: true })

    // 8) A few alerts
    await prisma.alert.createMany({
      data: [
        {
          userId: DEMO_USER_ID,
          kind: 'large_transaction',
          fingerprint: 'demo-large-1',
          severity: 'low',
          title: 'Large purchase detected',
          body: 'A purchase of $184.20 at BEST BUY is larger than your typical spend.',
        },
        {
          userId: DEMO_USER_ID,
          kind: 'budget_pace',
          fingerprint: 'demo-pace-1',
          severity: 'medium',
          title: 'Dining budget pace',
          body: "You're on track to exceed your Food & Dining budget this period.",
        },
        {
          userId: DEMO_USER_ID,
          kind: 'new_merchant',
          fingerprint: 'demo-newmerchant-1',
          severity: 'low',
          title: 'New merchant',
          body: 'First time seeing SWEETGREEN in your transactions.',
        },
      ],
    })

    // 9) Goals
    await prisma.goal.createMany({
      data: [
        {
          userId: DEMO_USER_ID,
          type: 'savings',
          name: 'Emergency Fund',
          targetAmount: '20000.00',
          startAmount: '9000.00',
          deadline: new Date(Date.UTC(now.getUTCFullYear(), 11, 31)),
        },
        {
          userId: DEMO_USER_ID,
          type: 'debt_payoff',
          name: 'Pay off Rewards Card',
          targetAmount: '0.00',
          startAmount: '1850.00',
          accountId: accountIds.get('card')!,
        },
      ],
    })

    console.log(
      `Done. ${dataset.items.length} institutions, ${dataset.accounts.length} accounts, ` +
        `${dataset.transactions.length} transactions, ${DEMO_BUDGETS.length} budgets, ` +
        `${snaps.length} snapshots, 3 alerts, 2 goals.\n` +
        `  classifier fixtures: ${dataset.cases.length} named cases\n  ${summarise(dataset.transactions)}`,
    )
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((e) => {
  console.error('Demo seed failed:', e)
  process.exit(1)
})

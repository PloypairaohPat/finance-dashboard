/**
 * seed-demo.ts — Populate a fully isolated, read-only DEMO user.
 *
 * Purpose: let employers open the live app and see a populated dashboard
 * WITHOUT logging in and WITHOUT touching your real Plaid-connected data.
 *
 * Safety:
 *   - Every row is scoped to DEMO_USER_ID. Nothing else is ever read or written.
 *   - Idempotent: re-running wipes ONLY the demo user's data, then rebuilds it.
 *   - No Plaid calls. All data is inserted directly via Prisma.
 *
 * Run from the backend/ directory:
 *   npx tsx prisma/seed-demo.ts
 *   (or: npx ts-node prisma/seed-demo.ts)
 *
 * Requires DATABASE_URL in the environment. This loads it from backend/.env
 * via dotenv (already a dependency of the Express app).
 */
import 'dotenv/config';
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

// Shared constant — the demo-auth middleware (Step 2) will map the demo
// session to this exact id. Export it so both sides stay in sync.
export const DEMO_USER_ID = 'demo-user';

const CURRENCY = 'USD';
const MONTHS_OF_HISTORY = 5;

// Amount sign convention (matches Plaid + your Phase 2 analytics):
//   positive = money OUT (spending)   negative = money IN (income)

// ── deterministic RNG so reseeds produce the same demo every time ──
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260825);
const between = (min: number, max: number) => min + rnd() * (max - min);
function pick<T>(arr: T[]): T {
  return arr[Math.floor(rnd() * arr.length)];
}
const money = (n: number) => n.toFixed(2);
const daysInMonth = (y: number, m: number) => new Date(y, m + 1, 0).getDate();

async function main() {
  console.log(`Seeding demo user "${DEMO_USER_ID}"…`);

  // 1) Wipe existing demo data (FK-safe order), scoped strictly to the demo user.
  await prisma.$transaction([
    prisma.transaction.deleteMany({ where: { userId: DEMO_USER_ID } }),
    prisma.account.deleteMany({ where: { userId: DEMO_USER_ID } }),
    prisma.plaidItem.deleteMany({ where: { userId: DEMO_USER_ID } }),
    prisma.budget.deleteMany({ where: { userId: DEMO_USER_ID } }),
    prisma.balanceSnapshot.deleteMany({ where: { userId: DEMO_USER_ID } }),
    prisma.alert.deleteMany({ where: { userId: DEMO_USER_ID } }),
    prisma.goal.deleteMany({ where: { userId: DEMO_USER_ID } }),
  ]);

  // 2) Demo user
  await prisma.user.upsert({
    where: { id: DEMO_USER_ID },
    update: {},
    create: { id: DEMO_USER_ID, email: 'demo@ledger.app' },
  });

  // 3) A placeholder PlaidItem to anchor the accounts. accessToken is a
  //    sentinel — the demo path must never trigger a Plaid sync (enforced
  //    server-side in Step 3), so this token is never used.
  const item = await prisma.plaidItem.create({
    data: {
      userId: DEMO_USER_ID,
      itemId: 'demo-item-1',
      accessToken: 'DEMO-NO-TOKEN',
      institutionId: 'ins_demo',
      institutionName: 'Demo Bank',
    },
  });

  // 4) Accounts
  const checking = await prisma.account.create({
    data: {
      userId: DEMO_USER_ID,
      plaidItemId: item.id,
      plaidAccountId: 'demo-acct-checking',
      name: 'Everyday Checking',
      officialName: 'Demo Bank Everyday Checking',
      type: 'depository',
      subtype: 'checking',
      mask: '0000',
      currentBalance: '4200.00',
      availableBalance: '4200.00',
      isoCurrencyCode: CURRENCY,
    },
  });
  const savings = await prisma.account.create({
    data: {
      userId: DEMO_USER_ID,
      plaidItemId: item.id,
      plaidAccountId: 'demo-acct-savings',
      name: 'High-Yield Savings',
      officialName: 'Demo Bank Savings',
      type: 'depository',
      subtype: 'savings',
      mask: '1111',
      currentBalance: '15200.00',
      availableBalance: '15200.00',
      isoCurrencyCode: CURRENCY,
    },
  });
  const card = await prisma.account.create({
    data: {
      userId: DEMO_USER_ID,
      plaidItemId: item.id,
      plaidAccountId: 'demo-acct-card',
      name: 'Rewards Card',
      officialName: 'Demo Bank Rewards Visa',
      type: 'credit',
      subtype: 'credit card',
      mask: '2222',
      currentBalance: '1450.00', // amount owed (liability)
      availableBalance: '3550.00',
      isoCurrencyCode: CURRENCY,
    },
  });

  // 5) Transactions across ~5 months
  const txns: Prisma.TransactionCreateManyInput[] = [];
  let seq = 0;
  const addTx = (
    date: Date,
    accountId: string,
    amount: number,
    name: string,
    primary: string,
    detailed: string,
    merchant?: string
  ) => {
    txns.push({
      userId: DEMO_USER_ID,
      accountId,
      plaidTransactionId: `demo-tx-${++seq}`,
      date,
      amount: money(amount),
      name,
      cleanName: merchant ?? name,
      merchantName: merchant ?? null,
      categoryPrimary: primary,
      categoryDetailed: detailed,
      isoCurrencyCode: CURRENCY,
      pending: false,
    });
  };

  const groceryMerchants = ['WHOLE FOODS', "TRADER JOE'S", 'SAFEWAY', 'COSTCO'];
  const diningMerchants = ['CHIPOTLE', 'STARBUCKS', 'SWEETGREEN', 'SHAKE SHACK', 'LOCAL THAI', 'BLUE BOTTLE'];
  const gasMerchants = ['SHELL', 'CHEVRON', 'ARCO'];
  const shopMerchants = ['AMAZON', 'TARGET', 'UNIQLO', 'BEST BUY'];
  const entMerchants = ['AMC THEATRES', 'STEAM', 'TICKETMASTER'];

  const today = new Date();
  const curY = today.getFullYear();
  const curM = today.getMonth();

  for (let back = MONTHS_OF_HISTORY - 1; back >= 0; back--) {
    const d = new Date(curY, curM - back, 1);
    const y = d.getFullYear();
    const m = d.getMonth();
    const isCurrent = back === 0;
    const lastDay = isCurrent ? today.getDate() : daysInMonth(y, m);
    const on = (day: number) => new Date(y, m, Math.min(day, lastDay));
    const has = (day: number) => day <= lastDay;

    // Income — two paychecks
    if (has(1)) addTx(on(1), checking.id, -between(2400, 2500), 'DIRECT DEP — PAYROLL', 'INCOME', 'INCOME_WAGES', 'Employer Payroll');
    if (has(15)) addTx(on(15), checking.id, -between(2400, 2500), 'DIRECT DEP — PAYROLL', 'INCOME', 'INCOME_WAGES', 'Employer Payroll');

    // Fixed bills (checking)
    if (has(1)) addTx(on(1), checking.id, 1650, 'GREYSTONE APARTMENTS', 'RENT_AND_UTILITIES', 'RENT', 'Greystone Apartments');
    if (has(8)) addTx(on(8), checking.id, between(84, 132), 'CITY POWER & LIGHT', 'RENT_AND_UTILITIES', 'UTILITIES', 'City Power & Light');
    if (has(10)) addTx(on(10), checking.id, 69.99, 'XFINITY INTERNET', 'RENT_AND_UTILITIES', 'INTERNET', 'Xfinity');
    if (has(12)) addTx(on(12), checking.id, 55.0, 'T-MOBILE', 'RENT_AND_UTILITIES', 'TELEPHONE', 'T-Mobile');
    if (has(20)) addTx(on(20), checking.id, 142.5, 'GEICO AUTO', 'RENT_AND_UTILITIES', 'INSURANCE', 'Geico');

    // Subscriptions (credit card)
    if (has(2)) addTx(on(2), card.id, 2.99, 'ICLOUD+', 'ENTERTAINMENT', 'SUBSCRIPTION', 'Apple iCloud');
    if (has(3)) addTx(on(3), card.id, 15.49, 'NETFLIX', 'ENTERTAINMENT', 'SUBSCRIPTION', 'Netflix');
    if (has(5)) addTx(on(5), card.id, 11.99, 'SPOTIFY', 'ENTERTAINMENT', 'SUBSCRIPTION', 'Spotify');
    if (has(6)) addTx(on(6), card.id, 39.0, 'CROSSFIT DOWNTOWN', 'ENTERTAINMENT', 'GYM', 'CrossFit Downtown');

    // Groceries (weekly, mixed accounts)
    [4, 11, 18, 25].forEach((day, i) => {
      if (has(day)) {
        const acct = i % 2 === 0 ? checking.id : card.id;
        const mrc = pick(groceryMerchants);
        addTx(on(day), acct, between(52, 148), mrc, 'GROCERIES', 'GROCERIES', mrc);
      }
    });

    // Dining (~9/month, credit card)
    for (let i = 0; i < 9; i++) {
      const day = Math.floor(between(1, 28));
      if (has(day)) {
        const mrc = pick(diningMerchants);
        addTx(on(day), card.id, between(8, 54), mrc, 'FOOD_AND_DRINK', 'RESTAURANT', mrc);
      }
    }

    // Gas / transport
    [7, 17, 27].forEach((day) => {
      if (has(day)) {
        const mrc = pick(gasMerchants);
        addTx(on(day), checking.id, between(32, 61), mrc, 'TRANSPORTATION', 'GAS', mrc);
      }
    });
    if (has(9)) addTx(on(9), card.id, between(11, 33), 'UBER TRIP', 'TRANSPORTATION', 'RIDESHARE', 'Uber');

    // Shopping
    [14, 23].forEach((day) => {
      if (has(day)) {
        const mrc = pick(shopMerchants);
        addTx(on(day), card.id, between(24, 190), mrc, 'GENERAL_MERCHANDISE', 'ONLINE_MARKETPLACE', mrc);
      }
    });

    // Entertainment
    if (has(21)) {
      const mrc = pick(entMerchants);
      addTx(on(21), card.id, between(14, 68), mrc, 'ENTERTAINMENT', 'EVENTS', mrc);
    }
  }

  await prisma.transaction.createMany({ data: txns });

  // 6) Budgets — categories match categoryPrimary above so utilization is real
  await prisma.budget.createMany({
    data: [
      { userId: DEMO_USER_ID, category: 'GROCERIES', monthlyLimit: '500.00' },
      { userId: DEMO_USER_ID, category: 'FOOD_AND_DRINK', monthlyLimit: '300.00' },
      { userId: DEMO_USER_ID, category: 'TRANSPORTATION', monthlyLimit: '200.00' },
      { userId: DEMO_USER_ID, category: 'GENERAL_MERCHANDISE', monthlyLimit: '250.00' },
      { userId: DEMO_USER_ID, category: 'ENTERTAINMENT', monthlyLimit: '120.00' },
    ],
  });

  // 7) Monthly balance snapshots (drives the net-worth trend)
  const snaps: Prisma.BalanceSnapshotCreateManyInput[] = [];
  for (let back = MONTHS_OF_HISTORY; back >= 0; back--) {
    const d = new Date(curY, curM - back + 1, 0); // last day of that month
    const step = MONTHS_OF_HISTORY - back;
    const mk = (acctId: string, name: string, type: string, bal: number, avail?: number) =>
      snaps.push({
        userId: DEMO_USER_ID,
        accountId: acctId,
        accountName: name,
        accountType: type,
        currentBalance: money(bal),
        availableBalance: avail != null ? money(avail) : null,
        isoCurrencyCode: CURRENCY,
        date: d,
      });
    mk(checking.id, 'Everyday Checking', 'depository', between(3600, 4600));
    mk(savings.id, 'High-Yield Savings', 'depository', 9000 + step * 1240);
    mk(card.id, 'Rewards Card', 'credit', between(1000, 1850));
  }
  await prisma.balanceSnapshot.createMany({ data: snaps, skipDuplicates: true });

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
        body: "You're on track to exceed your Food & Drink budget this month.",
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
  });

  // 9) Goals
  await prisma.goal.createMany({
    data: [
      {
        userId: DEMO_USER_ID,
        type: 'savings',
        name: 'Emergency Fund',
        targetAmount: '20000.00',
        startAmount: '9000.00',
        deadline: new Date(curY, 11, 31),
      },
      {
        userId: DEMO_USER_ID,
        type: 'debt_payoff',
        name: 'Pay off Rewards Card',
        targetAmount: '0.00',
        startAmount: '1850.00',
        accountId: card.id,
      },
    ],
  });

  console.log(
    `Done. Seeded: 3 accounts, ${txns.length} transactions, 5 budgets, ` +
      `${snaps.length} snapshots, 3 alerts, 2 goals for "${DEMO_USER_ID}".`
  );
}

main()
  .catch((e) => {
    console.error('Demo seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
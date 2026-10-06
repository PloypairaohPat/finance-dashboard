// ─────────────────────────────────────────────────────────────────
//  The demo reseed's table orders, in a module of their own so a test can
//  check them without running the seed (seed-demo.ts runs on import).
//
//  WIPE_ORDER must cover every table that carries a user (NON_DEMO_TABLES,
//  except User, which the seed keeps): tests/demo-tables.test.ts fails if a
//  new table is missing. Children before parents: every foreign key from these
//  tables restricts, so a wrong order fails the wipe rather than spreading.
// ─────────────────────────────────────────────────────────────────

/** The tables the wipe clears, in foreign-key-safe order. Prisma delegate names. */
export const WIPE_ORDER = [
  'subscriptionMark', 'transaction', 'account', 'recurringStream', 'plaidItem',
  'budget', 'balanceSnapshot', 'alert', 'goal',
] as const

/** The tables the rebuild fills, each with one createMany. Streams after their Items; marks after the transactions they anchor on. */
export const CREATE_ORDER = ['plaidItem', 'account', 'budget', 'balanceSnapshot', 'goal', 'transaction', 'recurringStream', 'subscriptionMark'] as const

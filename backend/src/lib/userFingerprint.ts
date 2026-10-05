// ─────────────────────────────────────────────────────────────────
//  userFingerprint — prove a bulk write left every other user alone.
//
//  Used by the demo reseed (everyone but the demo user) and by account
//  deletion (everyone but the user being deleted). Lives in src/ because the
//  app uses it; scripts/lib/non-demo-baseline.ts re-exports it.
//
//  The demo seed deletes and rebuilds rows in a database that also holds real
//  users. One unscoped deleteMany would wipe them. So the seed takes this
//  fingerprint of every NON-demo row before it writes, takes it again after,
//  inside the same transaction, and throws on any difference — which rolls the
//  whole rebuild back. A check after commit would only report damage already
//  done.
//
//  Per table and per user: a row count, and an md5 of the sorted row ids. The
//  count catches a delete; the id hash also catches a delete-and-replace that
//  happens to keep the count. The seed never UPDATEs a non-demo row (every
//  write it makes is a demo-scoped delete or a create), so ids are enough.
//
//  Every table that carries a user is here, plus the User rows themselves.
//  Adding a table to the schema means adding it to NON_DEMO_TABLES; the seed's
//  test fails if the two drift.
// ─────────────────────────────────────────────────────────────────

import { DEMO_USER_ID } from '../middleware/auth'

/** [table, the column that says whose row it is]. Constants only: interpolated into SQL. */
export const NON_DEMO_TABLES: ReadonlyArray<readonly [string, string]> = [
  ['User', 'id'],
  ['PlaidItem', 'userId'],
  ['Account', 'userId'],
  ['Transaction', 'userId'],
  ['Budget', 'userId'],
  ['BalanceSnapshot', 'userId'],
  ['Alert', 'userId'],
  ['Goal', 'userId'],
  ['SubscriptionMark', 'userId'],
] as const

export interface BaselineEntry {
  table: string
  user: string
  rows: number
  idHash: string
}

/** Anything that can run raw SQL: a PrismaClient, or the client inside a transaction. */
export interface RawQuerier {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>
}

/**
 * Every user's rows except `exclude`'s. The demo reseed excludes the demo user
 * (the default); deleting an account excludes the user being deleted, so the
 * demo user is fingerprinted like everyone else.
 */
export async function takeBaseline(db: RawQuerier, exclude: string = DEMO_USER_ID): Promise<BaselineEntry[]> {
  const out: BaselineEntry[] = []
  for (const [table, owner] of NON_DEMO_TABLES) {
    const rows = await db.$queryRawUnsafe<Array<{ owner: string; rows: number; id_hash: string }>>(
      `SELECT "${owner}" AS owner, count(*)::int AS rows, md5(string_agg(id, ',' ORDER BY id)) AS id_hash
       FROM "${table}"
       WHERE "${owner}" <> $1
       GROUP BY "${owner}"`,
      exclude,
    )
    for (const r of rows) out.push({ table, user: r.owner, rows: Number(r.rows), idHash: r.id_hash })
  }
  return out
}

/** Every difference between two baselines, in words. Empty means untouched. */
export function diffBaselines(before: BaselineEntry[], after: BaselineEntry[]): string[] {
  const key = (e: BaselineEntry) => `${e.table}|${e.user}`
  const a = new Map(before.map((e) => [key(e), e]))
  const b = new Map(after.map((e) => [key(e), e]))
  const who = (user: string) => `${user.slice(0, 12)}…`
  const out: string[] = []
  for (const [k, e] of a) {
    const f = b.get(k)
    if (!f) out.push(`${e.table}: all ${e.rows} row(s) of user ${who(e.user)} are gone`)
    else if (f.rows !== e.rows) out.push(`${e.table}: user ${who(e.user)} had ${e.rows} row(s), now ${f.rows}`)
    else if (f.idHash !== e.idHash) out.push(`${e.table}: user ${who(e.user)} has the same count but different rows`)
  }
  for (const [k, f] of b) {
    if (!a.has(k)) out.push(`${f.table}: ${f.rows} new row(s) under user ${who(f.user)}, who had none`)
  }
  return out
}

/** Per-table totals across all non-demo users, for printing. */
export function summariseBaseline(entries: BaselineEntry[]): Array<{ table: string; users: number; rows: number }> {
  return NON_DEMO_TABLES.map(([table]) => {
    const mine = entries.filter((e) => e.table === table)
    return { table, users: mine.length, rows: mine.reduce((s, e) => s + e.rows, 0) }
  })
}

// Tables in the public schema that nothing accounts for (M7.7).
//
// Every table must be either a user table (NON_DEMO_TABLES: covered by
// account deletion, the inventory, the fingerprint and the demo wipe) or one
// of the few known tables that deliberately aren't. Anything else, such as a
// copy made by hand in the SQL editor, holds data no deletion reaches: that's
// how "Budget_backup_m53" sat unnoticed from M5.3 to M7.7.

import { NON_DEMO_TABLES } from '../../src/lib/userFingerprint'

/** Tables that hold no per-user rows to delete, on purpose. */
export const KNOWN_NON_USER_TABLES = [
  // Outlives the user by design: keyed hashes and codes only (M7.7).
  'AuditEvent',
  // Prisma's migration history.
  '_prisma_migrations',
] as const

interface Querier {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>
}

/** Base tables in public that are neither user tables nor known ones, sorted. */
export async function strayTables(db: Querier): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT table_name AS name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  )
  const known = new Set<string>([...NON_DEMO_TABLES.map(([t]) => t), ...KNOWN_NON_USER_TABLES])
  return rows.map((r) => r.name).filter((n) => !known.has(n)).sort()
}

// ─────────────────────────────────────────────────────────────────
//  recurring-backfill — the write half of scripts/backfill-recurring-streams.ts,
//  here so it can be tested. Applies already-fetched streams for many Items in
//  ONE transaction, through the refresh's own apply, and refuses (rolling
//  back) unless the streams written equal `expect` and every non-demo row
//  outside RecurringStream is unchanged.
// ─────────────────────────────────────────────────────────────────

import { Prisma, type PrismaClient } from '@prisma/client'
import { NON_DEMO_TABLES } from '../../src/lib/userFingerprint'
import { applyItemStreams, type FetchedStreams } from '../../src/services/recurringStreams.service'

const DEMO_USER_IDS = ['demo-user']

export class RecurringBackfillRefused extends Error {}

/**
 * Full-row fingerprint of every non-demo row in every user table except
 * RecurringStream, leaving out PlaidItem.streamsRefreshedAt: the refresh
 * stamps it on every Item it applies, so a rerun would otherwise abort.
 */
export async function fingerprintOutsideStreams(db: Prisma.TransactionClient | PrismaClient): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const [table, owner] of NON_DEMO_TABLES) {
    if (table === 'RecurringStream') continue
    const [r] = await db.$queryRawUnsafe<Array<{ n: number; h: string | null }>>(
      `SELECT count(*)::int AS n, md5(string_agg(md5((to_jsonb(t) - 'streamsRefreshedAt')::text), '' ORDER BY t.id)) AS h
       FROM "${table}" t WHERE t."${owner}" <> ALL($1::text[])`,
      DEMO_USER_IDS,
    )
    out[table] = `${r.n}:${r.h ?? ''}`
  }
  return out
}

export async function runRecurringBackfill(
  db: PrismaClient,
  fetched: FetchedStreams[],
  expect: number,
  options: { timeoutMs?: number; insideTransaction?: (tx: Prisma.TransactionClient) => Promise<unknown> } = {},
): Promise<{ written: number; removed: number }> {
  return db.$transaction(async (tx) => {
    const before = await fingerprintOutsideStreams(tx)
    let written = 0, removed = 0
    for (const f of fetched) {
      const r = await applyItemStreams(tx, f)
      written += r.written
      removed += r.removed
    }
    if (options.insideTransaction) await options.insideTransaction(tx)
    if (written !== expect) {
      throw new RecurringBackfillRefused(`--expect ${expect}, but ${written} stream(s) would be written. Either the figure passed is ` +
        "not the dry run's, or Plaid or our rows changed since it ran. Dry-run again and pass its \"streams to write\" figure.")
    }
    const after = await fingerprintOutsideStreams(tx)
    const changed = Object.keys(before).filter((t) => before[t] !== after[t])
    if (changed.length > 0) throw new RecurringBackfillRefused(`rows outside RecurringStream changed (${changed.join(', ')}), so nothing was written`)
    return { written, removed }
  }, {
    // One snapshot for both fingerprints, so a write another user commits
    // mid-run (their sync, an alert) can't look like a change this run made.
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    timeout: options.timeoutMs ?? 120_000,
    maxWait: 15_000,
  })
}

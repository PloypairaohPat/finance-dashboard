// ─────────────────────────────────────────────────────────────────
//  entity-backfill — fill Transaction.merchantEntityId and
//  counterpartyEntities from rawJson, for rows no new code has written yet.
//
//  Which rows: counterpartyEntities IS NULL. The migration adds the column
//  with no default, so every row that existed before it is NULL, and every
//  writer since (plaidSync on create and update, the demo seed) writes a list,
//  possibly empty. That distinction is the point: rawJson is the payload a row
//  was CREATED from, so a row plaidSync has since modified holds newer ids than
//  its rawJson. Filling "every row whose columns are empty" would overwrite
//  those with stale ones; filling only NULL rows never touches them.
//
//  The real run, in one REPEATABLE READ transaction:
//    1. fingerprint every Transaction row with the two columns left out;
//    2. re-plan, and refuse unless the plan still matches what the dry run
//       projected (the caller's `expect`);
//    3. one UPDATE, NULL rows only;
//    4. refuse unless it updated exactly `expect` rows, no NULL row remains,
//       and the fingerprint is unchanged — nothing but the two columns moved.
//  Any refusal rolls everything back. Raw SQL, so updatedAt is not bumped
//  either: it is part of the fingerprint.
// ─────────────────────────────────────────────────────────────────

import { Prisma, PrismaClient } from '@prisma/client'
import { entityColumns, type PlaidEntityFields } from '../../src/lib/entityColumns'

type Db = PrismaClient | Prisma.TransactionClient

export interface BackfillPlan {
  /** Rows the backfill would write: every row whose counterpartyEntities is NULL. */
  rows: Array<{ id: string; merchantEntityId: string | null; counterpartyEntities: string[] }>
  /** Of those, how many get a merchant entity id, and how many a non-empty counterparty list. */
  withMerchantEntityId: number
  withCounterpartyEntities: number
  /** Of those, how many have no rawJson (they get null and an empty list). */
  withoutRawJson: number
  /** Every Transaction row, for scale. */
  totalRows: number
}

export async function planBackfill(db: Db): Promise<BackfillPlan> {
  const pending = await db.$queryRaw<Array<{ id: string; rawJson: unknown }>>`
    SELECT id, "rawJson" FROM "Transaction" WHERE "counterpartyEntities" IS NULL ORDER BY id`
  const [{ n }] = await db.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "Transaction"`
  const rows = pending.map((r) => ({ id: r.id, ...entityColumns(r.rawJson as PlaidEntityFields | null) }))
  return {
    rows,
    withMerchantEntityId: rows.filter((r) => r.merchantEntityId).length,
    withCounterpartyEntities: rows.filter((r) => r.counterpartyEntities.length > 0).length,
    withoutRawJson: pending.filter((r) => r.rawJson == null).length,
    totalRows: n,
  }
}

/** One hash over every row, with the two backfilled columns left out. */
export async function fingerprint(db: Db): Promise<{ rows: number; hash: string }> {
  const [r] = await db.$queryRaw<Array<{ rows: number; hash: string | null }>>`
    SELECT count(*)::int AS rows,
           md5(string_agg(md5((to_jsonb(t) - 'merchantEntityId' - 'counterpartyEntities')::text), '' ORDER BY t.id)) AS hash
    FROM "Transaction" t`
  return { rows: r.rows, hash: r.hash ?? '' }
}

export class BackfillRefused extends Error {}

export interface BackfillResult {
  updated: number
  withMerchantEntityId: number
  withCounterpartyEntities: number
}

/**
 * Run the backfill on `prisma`, refusing (and rolling back) unless exactly
 * `expect` rows are written and nothing but the two columns changes.
 */
export async function runBackfill(
  prisma: PrismaClient,
  expect: number,
  options: { timeoutMs?: number; maxWaitMs?: number } = {},
): Promise<BackfillResult> {
  return prisma.$transaction(
    async (tx) => {
      const before = await fingerprint(tx)
      const plan = await planBackfill(tx)
      if (plan.rows.length !== expect) {
        throw new BackfillRefused(
          `--expect ${expect}, but ${plan.rows.length} row(s) need filling. ` +
          "Either the figure passed is not the dry run's, or rows changed since it ran " +
          '(a sync may have written in between). Dry-run again and pass its "rows to fill" figure.',
        )
      }
      let updated = 0
      if (plan.rows.length > 0) {
        const payload = JSON.stringify(plan.rows.map((r) => ({ id: r.id, mid: r.merchantEntityId, cps: r.counterpartyEntities })))
        updated = await tx.$executeRaw`
          UPDATE "Transaction" AS t
          SET "merchantEntityId" = x.mid,
              "counterpartyEntities" = ARRAY(SELECT jsonb_array_elements_text(x.cps))
          FROM jsonb_to_recordset(${payload}::jsonb) AS x(id text, mid text, cps jsonb)
          WHERE t.id = x.id AND t."counterpartyEntities" IS NULL`
      }
      if (updated !== expect) {
        throw new BackfillRefused(`expected to update ${expect} row(s), updated ${updated}.`)
      }
      const [{ left }] = await tx.$queryRaw<Array<{ left: number }>>`
        SELECT count(*)::int AS left FROM "Transaction" WHERE "counterpartyEntities" IS NULL`
      if (left !== 0) throw new BackfillRefused(`${left} row(s) are still unfilled after the update.`)
      const after = await fingerprint(tx)
      if (after.rows !== before.rows || after.hash !== before.hash) {
        throw new BackfillRefused('something other than the two entity columns changed.')
      }
      return {
        updated,
        withMerchantEntityId: plan.withMerchantEntityId,
        withCounterpartyEntities: plan.withCounterpartyEntities,
      }
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: options.timeoutMs ?? 120_000,
      maxWait: options.maxWaitMs ?? 10_000,
    },
  )
}

// ─────────────────────────────────────────────────────────────────
//  backfill-entity-columns — fill Transaction.merchantEntityId and
//  counterpartyEntities from rawJson for rows written before the
//  transaction_entity_ids migration. Counts only: no ids, names or amounts.
//
//  Run AFTER the deploy that carries the migration and the plaidSync change,
//  so every row written from then on already has its columns.
//
//    dry run (read-only):
//      railway run npx tsx scripts/backfill-entity-columns.ts --allow-remote <db host> --dry-run
//    real run, with the dry run's figure:
//      railway run npx tsx scripts/backfill-entity-columns.ts --allow-remote <db host> --expect <rows>
//
//  Which database: scripts/lib/read-only-db.ts resolveConnection (DIRECT_URL,
//  then DATABASE_URL; --allow-remote must name the host). What the real run
//  checks before it commits: scripts/lib/entity-backfill.ts.
// ─────────────────────────────────────────────────────────────────

import { PrismaClient } from '@prisma/client'
import { connectReadOnly, flag, hasFlag, makeRefuse, redact, resolveConnection } from './lib/read-only-db'
import { planBackfill, runBackfill } from './lib/entity-backfill'

const SCRIPT = 'backfill-entity-columns'
const TIMEOUT_MS = 120_000
const refuse: (message: string) => never = makeRefuse(SCRIPT)

async function dryRun(): Promise<void> {
  const db = await connectReadOnly(SCRIPT)
  try {
    console.log(`\n${SCRIPT} — DRY RUN on ${db.database} at ${db.host} via ${db.envName}, read-only (${db.writeRefusedWith}).\n`)
    const plan = await planBackfill(db.prisma)
    console.log(`  Transaction rows                ${plan.totalRows}`)
    console.log(`  rows to fill (columns NULL)     ${plan.rows.length}`)
    console.log(`    will get a merchant entity id ${plan.withMerchantEntityId}`)
    console.log(`    will get counterparty ids     ${plan.withCounterpartyEntities}`)
    console.log(`    have no rawJson (stay empty)  ${plan.withoutRawJson}`)
    console.log(`  timeout                         ${TIMEOUT_MS / 1000} s, one transaction\n`)
    console.log(`  To write: the same command with --expect ${plan.rows.length} instead of --dry-run.\n`)
  } finally {
    await db.prisma.$disconnect()
  }
}

async function write(): Promise<void> {
  const raw = flag('expect')
  if (raw === undefined || !/^\d+$/.test(raw)) {
    refuse('the real run needs --expect <rows>, the "rows to fill" figure from a dry run.')
  }
  const expect = Number(raw)
  const conn = resolveConnection(SCRIPT)
  console.log(`\n${SCRIPT} — writing to ${conn.url.pathname.replace(/^\//, '')} on ${conn.host} via ${conn.envName}`)
  // Its own client on exactly the resolved URL, as the demo seed does.
  const prisma = new PrismaClient({ datasourceUrl: conn.url.toString() })
  try {
    const result = await runBackfill(prisma, expect, { timeoutMs: TIMEOUT_MS })
    console.log('  committed.\n')
    console.log(`  rows filled                     ${result.updated}`)
    console.log(`    with a merchant entity id     ${result.withMerchantEntityId}`)
    console.log(`    with counterparty ids         ${result.withCounterpartyEntities}`)
    console.log('  Checked inside the transaction before commit: the count matched --expect, no row is left')
    console.log('  unfilled, and every other column of every row (updatedAt included) is unchanged.\n')
  } catch (e: any) {
    console.error(`\n✗ ${SCRIPT}: rolled back. Nothing was written.`)
    console.error(`  ${redact(String(e?.message ?? e)).split('\n').join('\n  ')}\n`)
    process.exitCode = 1
  } finally {
    await prisma.$disconnect()
  }
}

async function main() {
  if (hasFlag('dry-run')) await dryRun()
  else await write()
}

main().catch((e) => {
  console.error(redact(String(e?.stack ?? e)))
  process.exit(1)
})

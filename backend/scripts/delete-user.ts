// ─────────────────────────────────────────────────────────────────
//  delete-user — "Delete account and all data", for someone who asks by
//  message rather than in Settings. The SAME service as DELETE /user
//  (src/services/accountDeletion.service.ts): ban in Clerk, remove every Item
//  at Plaid, every row in one transaction with every other user checked
//  identical, delete the Clerk account, sweep again.
//
//  It decrypts Plaid access tokens (to remove the Items) and calls Clerk, so
//  it runs through Railway, where ENCRYPTION_KEY, PLAID_SECRET and
//  CLERK_SECRET_KEY live:
//
//    dry run (read-only, counts only):
//      railway run npx tsx scripts/delete-user.ts --allow-remote <db host> --user <id> --dry-run
//    real run (the id twice, on purpose):
//      railway run npx tsx scripts/delete-user.ts --allow-remote <db host> --user <id> --confirm <id>
//
//  Rerunning is safe: a finished step finds nothing to do. That is how a
//  pending Clerk deletion is finished.
//
//  Never prints a token. Prints the user only as the first 12 characters.
// ─────────────────────────────────────────────────────────────────

import { PrismaClient } from '@prisma/client'
import { connectReadOnly, flag, hasFlag, makeRefuse, redact, resolveConnection } from './lib/read-only-db'
import { NON_DEMO_TABLES } from '../src/lib/userFingerprint'
import { assertDeletable, DeletionError, DeletionUnderway } from '../src/services/accountDeletion.service'

const SCRIPT = 'delete-user'
const refuse: (message: string) => never = makeRefuse(SCRIPT)

const CHECKLIST = `
Copies this script can't reach — check each by hand, then reply to the person:
  [ ] Local database dumps or exports made while debugging (delete any that include this user).
  [ ] Gitignored local analysis files: notebooks, CSV or spreadsheet exports, scratch query output.
  [ ] Your own notes, messages or screenshots that quote their transactions, balances or ids.
  [ ] Database backups and service logs: they age out on their own (see "Delete account and
      all data" in the app for the exact retention). Nothing to do but not restore from them.
`

async function counts(db: { $queryRawUnsafe: PrismaClient['$queryRawUnsafe'] }, userId: string) {
  const out: Array<[string, number]> = []
  for (const [table, owner] of NON_DEMO_TABLES) {
    const [r] = await db.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "${table}" WHERE "${owner}" = $1`, userId)
    out.push([table, r.n])
  }
  return out
}

async function main() {
  const userId = flag('user') ?? refuse('pass --user <id>, the Clerk user id to delete.')
  // The demo user, and an empty id, are refused before anything connects.
  try { assertDeletable(userId) } catch (e) { refuse((e as Error).message) }
  const who = `${userId.slice(0, 12)}…`

  if (hasFlag('dry-run')) {
    const db = await connectReadOnly(SCRIPT)
    try {
      console.log(`\n${SCRIPT} — DRY RUN on ${db.database} at ${db.host}, read-only (${db.writeRefusedWith}).`)
      console.log(`Would delete user ${who}:`)
      for (const [table, n] of await counts(db.prisma, userId)) console.log(`  ${table.padEnd(16)} ${n}`)
      console.log(`Plus: their Items removed at Plaid, then their Clerk account deleted.`)
      console.log(`\nTo delete: the same command with --confirm ${userId.slice(0, 12)}… (the full id) instead of --dry-run.\n`)
    } finally {
      await db.prisma.$disconnect()
    }
    return
  }

  if (flag('confirm') !== userId) refuse('the real run needs --confirm with the same user id as --user.')

  const conn = resolveConnection(SCRIPT)
  console.log(`\n${SCRIPT} — deleting user ${who} on ${conn.host} via ${conn.envName}`)
  const db = new PrismaClient({ datasourceUrl: conn.url.toString() })
  // Loaded only now: both read their credentials from the environment.
  const { plaidClient } = await import('../src/lib/plaidClient')
  const { clerkClient } = await import('@clerk/express')
  const { deleteUserData } = await import('../src/services/accountDeletion.service')
  try {
    const report = await deleteUserData(userId, { plaidClient, clerk: clerkClient.users, db })
    console.log(`  Items removed at Plaid   ${report.itemsRemoved}`)
    for (const [table, n] of Object.entries(report.rowsDeleted)) console.log(`  ${table.padEnd(24)} ${n} deleted`)
    console.log(`  Checked inside the transaction: every other user's rows identical; none of theirs left.`)
    console.log(`  Second sweep removed      ${report.sweptAfter}`)
    if (report.clerkDeleted) {
      console.log('  Clerk account            deleted\n')
    } else {
      console.log(`  Clerk account            NOT deleted — the user is banned and their data is gone.`)
      console.log(`                           Pending Clerk user id: ${userId}`)
      console.log(`                           Rerun this command to finish (also reported to Sentry).\n`)
      process.exitCode = 2
    }
    console.log(CHECKLIST)
  } catch (e: any) {
    console.error(`\n✗ ${SCRIPT}: ${e instanceof DeletionError || e instanceof DeletionUnderway ? e.message : 'stopped'}`)
    console.error(`  ${redact(String(e?.message ?? e)).split('\n').join('\n  ')}\n`)
    process.exitCode = 1
  } finally {
    await db.$disconnect()
  }
}

main().catch((e) => {
  console.error(redact(String(e?.stack ?? e)))
  process.exit(1)
})

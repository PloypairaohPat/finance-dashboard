// ─────────────────────────────────────────────────────────────────
//  post-restore-check — after restoring a backup for real, which restored
//  users were deleted after the backup was taken (M7.7). READ-ONLY.
//  See docs/backups.md, "After a restore".
//
//    railway run npx tsx scripts/post-restore-check.ts --allow-remote <restored db host> --taken-at <ISO time> [--old-url-env NAME] [--no-clerk]
//
//  Reads the users in the restored database (DIRECT_URL, or --url-env NAME),
//  read-only. Two sources say who was deleted since --taken-at:
//    - the old database's audit log, if it's still reachable (--old-url-env
//      names the variable holding its URL): deletion.completed events after
//      the backup's time, matched by keyed hash (AUDIT_HASH_KEY);
//    - Clerk: a restored user Clerk no longer has was deleted. Only valid on
//      the same Clerk instance: after a move to production keys every id
//      changes and every user would look deleted, so pass --no-clerk.
//  Prints "user N" for everyone else; for each user to delete again, the id
//  and the delete-user.ts command (terminal only). Changes nothing.
// ─────────────────────────────────────────────────────────────────

import { PrismaClient } from '@prisma/client'
import { connectReadOnly, flag, hasFlag, makeRefuse, redact } from './lib/read-only-db'
import { toDeleteAgain } from './lib/post-restore'

const SCRIPT = 'post-restore-check'
const refuse: (message: string) => never = makeRefuse(SCRIPT)

async function main() {
  const takenAtRaw = flag('taken-at') ?? refuse('pass --taken-at <ISO time>, when the restored backup was taken.')
  const takenAt = new Date(takenAtRaw)
  if (Number.isNaN(takenAt.getTime())) refuse('--taken-at is not a valid time.')
  const oldEnv = flag('old-url-env')
  const useClerk = !hasFlag('no-clerk')
  if (!oldEnv && !useClerk) refuse('with --no-clerk, pass --old-url-env so there is something to check against.')

  // Loaded after the flags: it validates AUDIT_HASH_KEY, which needs the environment.
  const { auditHash } = await import('../src/lib/auditKey')

  const restored = await connectReadOnly(SCRIPT)
  console.log(`\nRestored database: ${restored.database} on ${restored.host}, read-only (${restored.writeRefusedWith}).`)
  const users = (await restored.prisma.user.findMany({ select: { id: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map((u) => u.id)
  await restored.prisma.$disconnect()

  const deletedSubjects = new Set<string>()
  if (oldEnv) {
    const url = process.env[oldEnv] ?? refuse(`--old-url-env ${oldEnv} was given, but ${oldEnv} is not set.`)
    const u = new URL(url)
    u.searchParams.set('options', '-c default_transaction_read_only=on')
    const old = new PrismaClient({ datasourceUrl: u.toString() })
    try {
      const rows = await old.$queryRawUnsafe<Array<{ subject: string }>>(
        `SELECT DISTINCT subject FROM "AuditEvent" WHERE event = 'deletion.completed' AND subject IS NOT NULL AND at > ($1::timestamptz AT TIME ZONE 'UTC')`,
        takenAt.toISOString(),
      )
      rows.forEach((r) => deletedSubjects.add(r.subject))
      console.log(`Old database's audit log: ${rows.length} account deletion(s) completed after the backup.`)
    } finally {
      await old.$disconnect()
    }
  }

  let clerkGone: Set<string> | null = null
  if (useClerk) {
    const { clerkClient } = await import('@clerk/express')
    clerkGone = new Set()
    for (const id of users) {
      if (id === 'demo-user') continue
      try {
        await clerkClient.users.getUser(id)
      } catch (e: any) {
        if (e?.status === 404 || e?.errors?.[0]?.code === 'resource_not_found') clerkGone.add(id)
        else refuse('Clerk did not answer cleanly, so this run decides nothing. Try again, or use --no-clerk with --old-url-env.')
      }
    }
    console.log(`Clerk: ${clerkGone.size} restored user(s) no longer exist there.`)
  }

  const again = toDeleteAgain(users, deletedSubjects, (id) => auditHash('user', id), clerkGone)
  console.log(`\n${users.length} user(s) restored; ${again.length} to delete again.`)
  for (const d of again) {
    console.log(`\n  ${d.userId}  (${d.reasons.join(' and ')})`)
    console.log(`    railway run npx tsx scripts/delete-user.ts --allow-remote <db host> --user ${d.userId} --dry-run`)
  }
  if (again.length) console.log('\nRun each dry run first, then the real run it prints. delete-user.ts handles a user Clerk no longer has.')
  console.log('')
}

main().catch((e) => {
  console.error(redact(String(e?.stack ?? e)))
  process.exit(1)
})

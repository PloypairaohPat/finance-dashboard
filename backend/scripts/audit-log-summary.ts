// ─────────────────────────────────────────────────────────────────
//  audit-log-summary — the audit log at a glance (M7.7). READ-ONLY.
//
//  Counts (the default): events by outcome over the last 30 days and the
//  whole retention window, how old the oldest and newest rows are, rows past
//  retention waiting for expiry, deletions with no ending yet, and whether
//  the triggers that make the table append-only are all present and enabled.
//  No hash, id or exact time is printed.
//
//    railway run npx tsx scripts/audit-log-summary.ts --allow-remote <db host>
//
//  Lookup: what happened to one account or one bank connection. It asks for
//  the Clerk user id or Plaid item_id at a prompt (never on the command line,
//  so it stays out of shell history), hashes it here with AUDIT_HASH_KEY, and
//  prints that subject's events with their times. Neither the id nor its hash
//  is printed. Terminal only.
//
//    railway run npx tsx scripts/audit-log-summary.ts --allow-remote <db host> --lookup
//
//  Exit codes: 0 fine, 2 a problem with the table (missing, a trigger off, a
//  limit gone), 1 anything else.
// ─────────────────────────────────────────────────────────────────

import { connectReadOnly, hasFlag, makeRefuse, redact } from './lib/read-only-db'
import { auditHealth } from './lib/audit-triggers'
import { askLookup, onlyKnownArgs } from './lib/audit-lookup'
import { AUDIT_RETENTION_DAYS } from '../src/lib/auditValues'
import { auditHash } from '../src/lib/auditKey'

const SCRIPT = 'audit-log-summary'
const refuse: (message: string) => never = makeRefuse(SCRIPT)

type Db = Awaited<ReturnType<typeof connectReadOnly>>['prisma']

async function counts(db: Db) {
  const health = await auditHealth(db)
  console.log('Append-only')
  for (const t of health.triggers) console.log(`  ${t.ok ? 'ok     ' : 'PROBLEM'} ${t.name.padEnd(26)} ${t.enforces} (${t.state})`)
  console.log(`  ${health.missingChecks.length === 0 ? 'ok     ' : 'PROBLEM'} value limits${health.missingChecks.length ? `, missing: ${health.missingChecks.join(', ')}` : ''}`)
  console.log(`  ${health.retentionMatches ? 'ok     ' : 'PROBLEM'} the DELETE trigger's retention is ${AUDIT_RETENTION_DAYS} days`)

  const rows = await db.$queryRawUnsafe<Array<{ event: string; outcome: string; recent: number; kept: number }>>(
    `SELECT event,
            concat_ws(' ', 'plaid=' || "plaidResult", 'outcome=' || outcome, 'stage=' || stage) AS outcome,
            count(*) FILTER (WHERE at >= (now() AT TIME ZONE 'UTC') - interval '30 days')::int AS recent,
            count(*) FILTER (WHERE at >= (now() AT TIME ZONE 'UTC') - make_interval(days => $1::int))::int AS kept
     FROM "AuditEvent" GROUP BY 1, 2 ORDER BY 1, 2`,
    AUDIT_RETENTION_DAYS,
  )
  console.log(`\nEvents                                                       30 days  ${AUDIT_RETENTION_DAYS} days`)
  if (rows.length === 0) console.log('  (none)')
  for (const r of rows) console.log(`  ${`${r.event}${r.outcome ? `  ${r.outcome}` : ''}`.padEnd(58)} ${String(r.recent).padStart(7)}  ${String(r.kept).padStart(8)}`)

  const [s] = await db.$queryRawUnsafe<Array<{ total: number; oldest: number | null; newest: number | null; expired: number }>>(
    `SELECT count(*)::int AS total,
            floor(extract(epoch FROM (now() AT TIME ZONE 'UTC') - min(at)) / 86400)::int AS oldest,
            floor(extract(epoch FROM (now() AT TIME ZONE 'UTC') - max(at)) / 86400)::int AS newest,
            count(*) FILTER (WHERE at < (now() AT TIME ZONE 'UTC') - make_interval(days => $1::int))::int AS expired
     FROM "AuditEvent"`,
    AUDIT_RETENTION_DAYS,
  )
  console.log(`\nRows ${s.total}; oldest ${s.oldest ?? '-'} day(s) ago, newest ${s.newest ?? '-'} day(s) ago; past retention, awaiting expiry: ${s.expired}`)

  // A deletion whose latest step is "requested" or "incomplete" hasn't ended.
  const [d] = await db.$queryRawUnsafe<Array<{ open: number; incomplete: number }>>(
    `SELECT count(*)::int AS open, count(*) FILTER (WHERE event = 'deletion.incomplete')::int AS incomplete
     FROM (SELECT DISTINCT ON (subject) subject, event FROM "AuditEvent"
           WHERE event LIKE 'deletion.%' ORDER BY subject, id DESC) latest
     WHERE event IN ('deletion.requested', 'deletion.incomplete')`,
  )
  console.log(`Deletions with no ending yet: ${d.open} (of which left incomplete, user still banned: ${d.incomplete})\n`)

  if (health.triggers.some((t) => !t.ok) || health.missingChecks.length || !health.retentionMatches) process.exitCode = 2
}

async function lookup(db: Db) {
  const target = await askLookup(process.stdin, process.stdout)
  if (!target) refuse('nothing to look up: answer a or i, then the id.')
  let hash: string
  try {
    hash = auditHash(target.kind, target.id)
  } catch (e: any) {
    // The key's own message, which never includes its value.
    refuse(`${e.message} Run this through \`railway run\`, where AUDIT_HASH_KEY is set.`)
  }
  const column = target.kind === 'user' ? 'subject' : '"itemRef"'
  const rows = await db.$queryRawUnsafe<Array<{
    at: Date; event: string; actor: string; plaidResult: string | null; outcome: string | null
    stage: string | null; errorCode: string | null; count: number | null; keyVersion: number
  }>>(
    `SELECT at, event, actor, "plaidResult", outcome, stage, "errorCode", count, "keyVersion"
     FROM "AuditEvent" WHERE ${column} = $1 ORDER BY id`,
    hash,
  )
  const what = target.kind === 'user' ? 'that account' : 'that bank connection'
  console.log(`${rows.length} event(s) for ${what} in the last ${AUDIT_RETENTION_DAYS} days (times in UTC):`)
  for (const r of rows) {
    const details = [
      r.plaidResult && `plaid=${r.plaidResult}`, r.outcome && `outcome=${r.outcome}`, r.stage && `stage=${r.stage}`,
      r.errorCode && `errorCode=${r.errorCode}`, r.count !== null && `count=${r.count}`,
    ].filter(Boolean).join(' ')
    console.log(`  ${r.at.toISOString().slice(0, 16).replace('T', ' ')}  ${r.event.padEnd(24)} ${r.actor.padEnd(9)} ${details}`)
  }
  if (rows.length === 0) console.log('  (none: a wrong id, a different AUDIT_HASH_KEY, or nothing recorded)')
  console.log('')
}

async function main() {
  // The id is only ever read at the prompt. Anything else on the command
  // line is refused unread, and isn't echoed back.
  if (!onlyKnownArgs(process.argv.slice(2))) {
    refuse('unexpected arguments. This script takes only --allow-remote <host>, --url-env <NAME> and --lookup; a lookup asks for its id at a prompt.')
  }
  const db = await connectReadOnly(SCRIPT)
  console.log(`\nReading ${db.database} on ${db.host} via ${db.envName} — read-only (${db.writeRefusedWith}).`)
  try {
    const [t] = await db.prisma.$queryRawUnsafe<Array<{ t: string | null }>>(`SELECT to_regclass('"AuditEvent"')::text AS t`)
    if (!t.t) {
      console.log('\nPROBLEM  the AuditEvent table does not exist in this database: the audit_event migration has not been applied here.\n')
      process.exitCode = 2
      return
    }
    if (hasFlag('lookup')) {
      console.log('Lookup: one account or bank connection.\n')
      await lookup(db.prisma)
    } else {
      console.log('Counts only.\n')
      await counts(db.prisma)
    }
  } finally {
    await db.prisma.$disconnect()
  }
}

main().catch((e) => {
  console.error(redact(String(e?.stack ?? e)))
  process.exit(1)
})

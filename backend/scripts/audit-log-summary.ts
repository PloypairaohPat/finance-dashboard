// ─────────────────────────────────────────────────────────────────
//  audit-log-summary — the audit log at a glance (M7.7). READ-ONLY.
//
//  Counts only: events by outcome over the last 30 days and the whole
//  retention window, how old the oldest and newest rows are, rows past
//  retention waiting for expiry, deletions with no ending yet, and whether
//  the triggers that make the table append-only are all present and enabled.
//  No hash, id or exact time is printed.
//
//    railway run npx tsx scripts/audit-log-summary.ts --allow-remote <db host>
//
//  Looking up one account or Item comes with PR 2, which brings the key.
// ─────────────────────────────────────────────────────────────────

import { connectReadOnly, redact } from './lib/read-only-db'
import { auditHealth } from './lib/audit-triggers'
import { AUDIT_RETENTION_DAYS } from '../src/lib/auditLog'

async function main() {
  const db = await connectReadOnly('audit-log-summary')
  console.log(`\nReading ${db.database} on ${db.host} via ${db.envName} — read-only (${db.writeRefusedWith}).`)
  console.log('Counts only.\n')
  try {
    const health = await auditHealth(db.prisma)
    console.log('Append-only')
    for (const t of health.triggers) console.log(`  ${t.ok ? 'ok     ' : 'PROBLEM'} ${t.name.padEnd(26)} ${t.enforces} (${t.state})`)
    console.log(`  ${health.missingChecks.length === 0 ? 'ok     ' : 'PROBLEM'} value limits${health.missingChecks.length ? `, missing: ${health.missingChecks.join(', ')}` : ''}`)
    console.log(`  ${health.retentionMatches ? 'ok     ' : 'PROBLEM'} the DELETE trigger's retention is ${AUDIT_RETENTION_DAYS} days`)

    const rows = await db.prisma.$queryRawUnsafe<Array<{ event: string; outcome: string; recent: number; kept: number }>>(
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

    const [s] = await db.prisma.$queryRawUnsafe<Array<{ total: number; oldest: number | null; newest: number | null; expired: number }>>(
      `SELECT count(*)::int AS total,
              floor(extract(epoch FROM (now() AT TIME ZONE 'UTC') - min(at)) / 86400)::int AS oldest,
              floor(extract(epoch FROM (now() AT TIME ZONE 'UTC') - max(at)) / 86400)::int AS newest,
              count(*) FILTER (WHERE at < (now() AT TIME ZONE 'UTC') - make_interval(days => $1::int))::int AS expired
       FROM "AuditEvent"`,
      AUDIT_RETENTION_DAYS,
    )
    console.log(`\nRows ${s.total}; oldest ${s.oldest ?? '-'} day(s) ago, newest ${s.newest ?? '-'} day(s) ago; past retention, awaiting expiry: ${s.expired}`)

    // A deletion whose latest step is "requested" or "incomplete" hasn't ended.
    const [d] = await db.prisma.$queryRawUnsafe<Array<{ open: number; incomplete: number }>>(
      `SELECT count(*)::int AS open, count(*) FILTER (WHERE event = 'deletion.incomplete')::int AS incomplete
       FROM (SELECT DISTINCT ON (subject) subject, event FROM "AuditEvent"
             WHERE event LIKE 'deletion.%' ORDER BY subject, id DESC) latest
       WHERE event IN ('deletion.requested', 'deletion.incomplete')`,
    )
    console.log(`Deletions with no ending yet: ${d.open} (of which left incomplete, user still banned: ${d.incomplete})\n`)

    if (health.triggers.some((t) => !t.ok) || health.missingChecks.length || !health.retentionMatches) process.exitCode = 2
  } finally {
    await db.prisma.$disconnect()
  }
}

main().catch((e) => {
  console.error(redact(String(e?.stack ?? e)))
  process.exit(1)
})

// ─────────────────────────────────────────────────────────────────
//  auditLog — the append-only log of security events (M7.7).
//
//  The ONLY code that touches the AuditEvent table, apart from
//  scripts/audit-log-summary.ts: recordAudit and recordSessionSeen write,
//  expireAuditEvents deletes what's past retention. tests/audit-log-writes
//  fails on anything else that reads or writes it.
//
//  A row outlives the user it's about, so it holds no personal data in the
//  clear: people, Items and sessions as keyed hashes (lib/auditKey.ts,
//  pseudonymous while we hold the key), everything else a code. Append-only
//  is the database's job: UPDATE and TRUNCATE are refused, and DELETE only
//  past retention.
//
//  The log never blocks what it records. Every write comes after its action
//  (deletion.requested before it, so a deletion that dies halfway shows no
//  ending), never inside the action's transaction, and never throws: a failed
//  write goes to Sentry as AUDIT_WRITE_FAILED with the event name only, and
//  the action stands.
// ─────────────────────────────────────────────────────────────────

import * as Sentry from '@sentry/node'
import type { PrismaClient } from '@prisma/client'
import defaultPrisma from './prisma'
import { AUDIT_KEY_VERSION, auditHash } from './auditKey'
import {
  AUDIT_ERROR_CODE_PATTERN, AUDIT_RETENTION_DAYS, AUDIT_STAGE_PATTERN,
  type AuditActor, type AuditEventName, type AuditOutcome, type AuditPlaidResult,
} from './auditValues'

export * from './auditValues'

/** The Sentry title when a row couldn't be written. An alert rule can notify on it. */
export const AUDIT_WRITE_FAILED = 'audit log: write failed'

/** One event, with raw ids: they're hashed here and never stored. */
export interface AuditEntry {
  event: AuditEventName
  actor: AuditActor
  /** The Clerk user id. */
  userId?: string | null
  /** Plaid's item_id (PlaidItem.itemId), not our row id. */
  itemId?: string | null
  plaidResult?: AuditPlaidResult | null
  outcome?: AuditOutcome | null
  stage?: string | null
  errorCode?: unknown
  count?: number | null
}

/** A code as its column takes it. Anything else (a message, lowercase) becomes OTHER, so the row still lands. */
export function auditCode(value: unknown, pattern: RegExp = AUDIT_ERROR_CODE_PATTERN): string | null {
  if (value === null || value === undefined || value === '') return null
  const s = String(value)
  return pattern.test(s) ? s : 'OTHER'
}

function rowOf(e: AuditEntry) {
  return {
    event: e.event,
    actor: e.actor,
    subject: e.userId ? auditHash('user', e.userId) : null,
    itemRef: e.itemId ? auditHash('item', e.itemId) : null,
    plaidResult: e.plaidResult ?? null,
    outcome: e.outcome ?? null,
    stage: auditCode(e.stage, AUDIT_STAGE_PATTERN),
    errorCode: auditCode(e.errorCode),
    count: e.count ?? null,
    keyVersion: AUDIT_KEY_VERSION,
  }
}

function reportWriteFailure(event: AuditEventName, err: unknown): void {
  // The event name and Prisma's code only: never the row, never an id.
  Sentry.captureMessage(AUDIT_WRITE_FAILED, { level: 'error', extra: { event, prismaCode: (err as any)?.code ?? null } })
  console.error(`❌ ${AUDIT_WRITE_FAILED}: ${event}`)
}

type AuditDb = Pick<PrismaClient, 'auditEvent'>

/** Write one event. Never throws. */
export async function recordAudit(e: AuditEntry, db: AuditDb = defaultPrisma): Promise<void> {
  try {
    await db.auditEvent.create({ data: rowOf(e) })
  } catch (err) {
    reportWriteFailure(e.event, err)
  }
}

// Sessions this process has already recorded (or is recording). Another
// instance, or a restart, may try again; the unique sessionRef makes that a
// no-op. Cleared when full rather than tracked by age: a repeat costs one
// insert that does nothing.
const seenSessions = new Set<string>()
const SEEN_LIMIT = 10_000

/**
 * The first time this backend sees a Clerk session. Callers don't wait for it
 * (`void recordSessionSeen(...)`); the promise never rejects, and a failure
 * goes to Sentry like every other write and is tried again on the next request.
 */
export function recordSessionSeen(userId: string, sessionId: string, db: AuditDb = defaultPrisma): Promise<void> {
  if (seenSessions.has(sessionId)) return Promise.resolve()
  if (seenSessions.size >= SEEN_LIMIT) seenSessions.clear()
  seenSessions.add(sessionId)
  return (async () => {
    try {
      await db.auditEvent.createMany({
        data: [{ ...rowOf({ event: 'session.first_seen', actor: 'user', userId }), sessionRef: auditHash('session', sessionId) }],
        skipDuplicates: true,
      })
    } catch (err) {
      seenSessions.delete(sessionId)
      reportWriteFailure('session.first_seen', err)
    }
  })()
}

/** Tests only: forget the sessions this process has seen, as a restart would. */
export function forgetSeenSessions(): void {
  seenSessions.clear()
}

/**
 * Delete rows past retention: the one DELETE the table's trigger allows. The
 * cutoff is computed in the database with the trigger's own expression, so
 * the app's clock can't make it reach a row the trigger would refuse (which
 * would fail the whole statement). Returns how many went.
 */
export async function expireAuditEvents(db: Pick<PrismaClient, '$executeRawUnsafe'> = defaultPrisma): Promise<number> {
  return db.$executeRawUnsafe(
    `DELETE FROM "AuditEvent" WHERE at < (now() AT TIME ZONE 'UTC') - make_interval(days => $1::int)`,
    AUDIT_RETENTION_DAYS,
  )
}

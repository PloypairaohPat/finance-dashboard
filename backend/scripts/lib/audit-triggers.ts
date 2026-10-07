// The audit log's database-side guarantees, read back from the catalogue:
// the summary script prints this, and tests/audit-log.test.ts checks it.

import { AUDIT_RETENTION_DAYS } from '../../src/lib/auditLog'

/** [trigger, what it enforces]. Each must exist and be enabled. */
export const AUDIT_TRIGGERS = [
  ['audit_event_set_at', '"at" is the insert time'],
  ['audit_event_no_update', 'UPDATE refused'],
  ['audit_event_expiry_only', `DELETE only past ${AUDIT_RETENTION_DAYS} days`],
  ['audit_event_no_truncate', 'TRUNCATE refused'],
] as const

export const AUDIT_CHECKS = [
  'AuditEvent_event_check', 'AuditEvent_actor_check', 'AuditEvent_plaidResult_check',
  'AuditEvent_outcome_check', 'AuditEvent_subject_check', 'AuditEvent_itemRef_check',
  'AuditEvent_sessionRef_check', 'AuditEvent_stage_check', 'AuditEvent_errorCode_check',
  'AuditEvent_count_check', 'AuditEvent_keyVersion_check', 'AuditEvent_subject_required',
  'AuditEvent_sessionRef_event',
] as const

interface Querier {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>
}

export interface AuditHealth {
  /** Per trigger: present and enabled ('O' = fires in normal sessions). */
  triggers: Array<{ name: string; enforces: string; ok: boolean; state: 'enabled' | 'disabled' | 'missing' }>
  missingChecks: string[]
  /** The DELETE trigger's interval matches AUDIT_RETENTION_DAYS. */
  retentionMatches: boolean
}

export async function auditHealth(db: Querier): Promise<AuditHealth> {
  const rows = await db.$queryRawUnsafe<Array<{ name: string; enabled: string }>>(
    `SELECT tgname AS name, tgenabled::text AS enabled FROM pg_trigger
     WHERE tgrelid = '"AuditEvent"'::regclass AND NOT tgisinternal`,
  )
  const state = new Map(rows.map((r) => [r.name, r.enabled]))
  const triggers = AUDIT_TRIGGERS.map(([name, enforces]) => {
    const s = state.get(name)
    const st = s === undefined ? 'missing' as const : s === 'O' || s === 'A' ? 'enabled' as const : 'disabled' as const
    return { name, enforces, ok: st === 'enabled', state: st }
  })
  const checks = await db.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT conname AS name FROM pg_constraint WHERE conrelid = '"AuditEvent"'::regclass AND contype = 'c'`,
  )
  const have = new Set(checks.map((c) => c.name))
  const [fn] = await db.$queryRawUnsafe<Array<{ def: string }>>(
    `SELECT pg_get_functiondef('audit_event_expiry_only'::regproc) AS def`,
  )
  return {
    triggers,
    missingChecks: AUDIT_CHECKS.filter((c) => !have.has(c)),
    retentionMatches: fn.def.includes(`'${AUDIT_RETENTION_DAYS} days'`),
  }
}

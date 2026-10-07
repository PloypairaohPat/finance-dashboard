// The values the AuditEvent table accepts (M7.7), kept in step with the
// migration's CHECK constraints by tests/audit-log.test.ts. No imports on
// purpose: read-only scripts import these before they open their connection,
// so this module must never construct a database client.

/** How long a row is kept. The migration's DELETE trigger uses the same number. */
export const AUDIT_RETENTION_DAYS = 400

export const AUDIT_EVENTS = [
  'item.linked', 'item.link_discarded', 'item.unlinked',
  'item.permission_revoked', 'item.account_revoked',
  'deletion.requested', 'deletion.stopped', 'deletion.incomplete', 'deletion.completed',
  'session.first_seen',
] as const

export const AUDIT_ACTORS = ['user', 'operator', 'plaid'] as const

/** What Plaid said to /item/remove. */
export const AUDIT_PLAID_RESULTS = ['removed', 'already_gone', 'failed'] as const

/** Our side's result, or why a link was discarded. */
export const AUDIT_OUTCOMES = ['ok', 'failed', 'duplicate', 'clerk_pending'] as const

/** stage and errorCode: capitals, digits and underscores only, so no message fits. */
export const AUDIT_STAGE_PATTERN = /^[A-Z0-9_]{1,32}$/
export const AUDIT_ERROR_CODE_PATTERN = /^[A-Z0-9_]{1,48}$/

export type AuditEventName = (typeof AUDIT_EVENTS)[number]
export type AuditActor = (typeof AUDIT_ACTORS)[number]
export type AuditPlaidResult = (typeof AUDIT_PLAID_RESULTS)[number]
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number]

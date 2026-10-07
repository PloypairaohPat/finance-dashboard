// ─────────────────────────────────────────────────────────────────
//  auditLog — the append-only log of security events (M7.7).
//
//  PR 1 is the table only: these are the values the database accepts, kept
//  in step with the migration's CHECK constraints by tests/audit-log.test.ts.
//  Nothing writes yet.
//
//  A row outlives the user it's about, so it holds no personal data in the
//  clear: people, Items and sessions as keyed hashes (pseudonymous while we
//  hold the key), everything else a code. Append-only is the database's job:
//  UPDATE and TRUNCATE are refused, and DELETE only past retention.
// ─────────────────────────────────────────────────────────────────

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

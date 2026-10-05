// ─────────────────────────────────────────────────────────────────
//  How long deleted data can survive outside the live database, for the
//  "Delete account and all data" wording. Set from the hosting plans:
//
//    BACKUP_RETENTION_DAYS  Supabase daily backups. Free: 0 (no backups),
//                           Pro: 7, Team: 14, Enterprise: up to 30; with the
//                           PITR add-on, its window (7, 14 or 28) instead.
//    LOG_RETENTION_DAYS     Railway logs. Hobby/Trial: 7, Pro: 30,
//                           Enterprise: up to 90.
//
//  null = not yet confirmed: the text says data ages out without naming a
//  number, rather than guessing one.
// ─────────────────────────────────────────────────────────────────

export const BACKUP_RETENTION_DAYS: number | null = null
export const LOG_RETENTION_DAYS: number | null = null

export function backupSentence(days = BACKUP_RETENTION_DAYS): string {
  if (days === 0) return "Our database host keeps no backups, so nothing lingers there."
  if (days === null) return "Database backups may still hold it until they expire on their own; they can't be edited."
  return `Database backups may still hold it for up to ${days} days, until they expire on their own; they can't be edited.`
}

export function logSentence(days = LOG_RETENTION_DAYS): string {
  if (days === null) return "Server logs, which record your account id but not your transactions, expire on their own."
  return `Server logs, which record your account id but not your transactions, expire within ${days} days.`
}

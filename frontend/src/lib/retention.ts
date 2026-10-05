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
//
//  Current plans (confirmed 2026-10-06): Supabase Free, no PITR → no automatic
//  backups; Railway Hobby → logs shown for 7 days. Change these when a plan
//  changes, and the deletion section of docs/what-changed-for-you.md with them.
// ─────────────────────────────────────────────────────────────────

export const BACKUP_RETENTION_DAYS: number | null = 0
export const LOG_RETENTION_DAYS: number | null = 7

export function backupSentence(days = BACKUP_RETENTION_DAYS): string {
  if (days === 0) return "Our database host keeps no automatic backups, so no backup copy lingers there."
  if (days === null) return "Database backups may still hold it until they expire on their own; they can't be edited."
  return `Database backups may still hold it for up to ${days} days, until they expire on their own; they can't be edited.`
}

export function logSentence(days = LOG_RETENTION_DAYS): string {
  if (days === null) return "Server logs, which record your account id but not your transactions, expire on their own."
  // Railway: expired logs drop out of view, but upgrading the plan restores
  // them, so they aren't necessarily destroyed. Say what's true.
  return `Server logs, which record your account id but not your transactions, drop out of view after ${days} days; our host may keep them longer internally.`
}

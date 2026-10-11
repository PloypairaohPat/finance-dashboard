// The restore drill's decisions, kept pure so tests can pin them
// (scripts/restore-drill.ts does the I/O). See docs/backups.md.

/** The name the backup job gives every object: ledger-<UTC date>T<HHMMSS>Z.dump.age. */
export const JOB_FILE_NAME = /^ledger-(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z\.dump\.age$/

/** When the job took this backup, from its name; null for any other name. */
export function takenAtFromName(fileName: string): Date | null {
  const m = JOB_FILE_NAME.exec(fileName)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m
  const t = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`)
  return Number.isNaN(t.getTime()) ? null : t
}

/** An age X25519 secret key: the prefix, then 58 upper-case bech32 characters. */
export function looksLikeAgeIdentity(s: string): boolean {
  return /^AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}$/.test(s.trim())
}

export interface AfterDrill {
  action: 'delete' | 'keep'
  /** One line for the terminal. */
  message: string
}

/**
 * What happens to the downloaded file. Only a file the backup job wrote, and
 * only after a pass, is deleted (unless --keep): no copy outlives the 30-day
 * retention. Anything else is never deleted, whatever happened, so pointing
 * the drill at a hand-made copy can't destroy it.
 */
export function afterDrill({ passed, fileName, keep }: { passed: boolean; fileName: string; keep: boolean }): AfterDrill {
  if (!JOB_FILE_NAME.test(fileName)) {
    return { action: 'keep', message: `${fileName} isn't named like a backup the job writes, so the drill never deletes it. Delete it yourself once you're done with it.` }
  }
  if (!passed) return { action: 'keep', message: `${fileName} is still there. Delete it once you're done.` }
  if (keep) return { action: 'keep', message: `${fileName} is still there (--keep). Delete it once you're done.` }
  return { action: 'delete', message: `Deleted ${fileName}: no copy of a backup outlives its 30-day retention.` }
}

/** Tables the restore must contain. */
export const REQUIRED_TABLES = ['User', 'AuditEvent', 'RecurringStream', 'SubscriptionMark', '_prisma_migrations'] as const

/** The column that says when a row was created; createdAt unless named here. */
export const CREATED_COLUMN: Record<string, string> = { AuditEvent: 'at', _prisma_migrations: 'started_at' }
export const createdColumnOf = (table: string) => CREATED_COLUMN[table] ?? 'createdAt'

export interface TableCounts {
  table: string
  /** Rows in the restored backup; null if the backup has no such table. */
  restored: number | null
  /** Production rows created at or before the backup's time; null if production has no such table or no created column. */
  productionThen: number | null
  /** Production rows now; null if production has no such table. */
  productionNow: number | null
}

export interface DrillVerdict {
  failures: string[]
  warnings: string[]
}

/**
 * Restored counts against production. Production keeps changing after the
 * backup, so the comparison is with production rows created at or before the
 * backup's time. Fewer rows in the backup than that means rows are missing:
 * a failure. More is expected after hard deletes since then (unlinks,
 * account deletions) and for rows written in the seconds before the dump's
 * snapshot: a warning, listed. Structural problems fail.
 */
export function judgeDrill(counts: TableCounts[], ctx: { hardDeletesSince: number; strayInBackup: string[]; auditHealthy: boolean }): DrillVerdict {
  const failures: string[] = []
  const warnings: string[] = []
  const byTable = new Map(counts.map((c) => [c.table, c]))
  for (const t of REQUIRED_TABLES) {
    if (byTable.get(t)?.restored == null) failures.push(`${t} is missing from the restored backup`)
  }
  if (!ctx.auditHealthy) failures.push("the restored AuditEvent's triggers or value limits aren't all in place")
  for (const t of ctx.strayInBackup) warnings.push(`${t} is in the backup but is neither a user table nor a known one`)
  for (const c of counts) {
    if (c.restored == null && c.productionNow != null) {
      failures.push(`${c.table} exists in production but not in the backup`)
    } else if (c.restored != null && c.productionNow == null) {
      warnings.push(`${c.table} is in the backup but no longer in production`)
    } else if (c.restored != null && c.productionThen != null) {
      if (c.restored < c.productionThen) {
        failures.push(`${c.table}: the backup has ${c.restored} row(s), production had at least ${c.productionThen} by then`)
      } else if (c.restored > c.productionThen) {
        const why = ctx.hardDeletesSince > 0 ? `${ctx.hardDeletesSince} unlink(s) or account deletion(s) since then` : 'rows written just before the snapshot'
        warnings.push(`${c.table}: the backup has ${c.restored - c.productionThen} more row(s) than production created by then (${why})`)
      }
    }
  }
  return { failures, warnings }
}

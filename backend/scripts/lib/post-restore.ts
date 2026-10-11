// Which restored users must be deleted again (M7.7, docs/backups.md). Pure,
// so the matching is tested; scripts/post-restore-check.ts does the I/O.

export type DeleteAgainReason = 'audit log' | 'Clerk'

export interface DeleteAgain {
  userId: string
  reasons: DeleteAgainReason[]
}

/**
 * A restored user was deleted after the backup if either:
 *  - the old database's audit log has a deletion.completed for their keyed
 *    hash after the backup's time (deletedSubjects), or
 *  - Clerk has no such user (clerkGone; null when the Clerk check is off,
 *    e.g. after a move to a different Clerk instance, where every id changes).
 */
export function toDeleteAgain(
  restoredUserIds: string[],
  deletedSubjects: ReadonlySet<string>,
  hash: (userId: string) => string,
  clerkGone: ReadonlySet<string> | null,
  demoUserId = 'demo-user',
): DeleteAgain[] {
  const out: DeleteAgain[] = []
  for (const id of restoredUserIds) {
    if (id === demoUserId) continue
    const reasons: DeleteAgainReason[] = []
    if (deletedSubjects.has(hash(id))) reasons.push('audit log')
    if (clerkGone?.has(id)) reasons.push('Clerk')
    if (reasons.length) out.push({ userId: id, reasons })
  }
  return out
}

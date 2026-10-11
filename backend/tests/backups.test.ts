// ─────────────────────────────────────────────────────────────────
//  Backups (M7.7): the restore drill's decisions and the post-restore
//  matching. The job itself (backup/run.sh) is exercised end to end by
//  backup/test/harness.mjs against throwaway containers; see docs/backups.md.
//  All ids, hashes and keys here are invented.
// ─────────────────────────────────────────────────────────────────

import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  JOB_FILE_NAME, afterDrill, createdColumnOf, judgeDrill, looksLikeAgeIdentity, takenAtFromName, type TableCounts,
} from '../scripts/lib/backup-drill'
import { toDeleteAgain } from '../scripts/lib/post-restore'

const JOB = 'ledger-2026-10-11T031704Z.dump.age'
const OCT9 = 'ledger-2026-10-09.dump.age'

describe('the names the backup job writes', () => {
  it('match run.sh exactly', () => {
    const sh = readFileSync(path.resolve(__dirname, '..', '..', 'backup', 'run.sh'), 'utf8')
    expect(sh).toContain('name="ledger-$(date -u +%Y-%m-%dT%H%M%SZ).dump.age"')
    expect(JOB_FILE_NAME.test(JOB)).toBe(true)
  })

  it('carry the time the backup was taken', () => {
    expect(takenAtFromName(JOB)?.toISOString()).toBe('2026-10-11T03:17:04.000Z')
  })

  it('never match a hand-made or renamed copy', () => {
    for (const n of [OCT9, 'ledger-manual-2026-10-12T101500Z.dump.age', 'ledger-2026-10-11T031704Z (1).dump.age', 'ledger-2026-10-11T031704Z.dump', `x${JOB}`]) {
      expect(JOB_FILE_NAME.test(n), n).toBe(false)
      expect(takenAtFromName(n), n).toBeNull()
    }
  })
})

describe('after a drill', () => {
  it('deletes a job backup after a pass', () => {
    expect(afterDrill({ passed: true, fileName: JOB, keep: false }).action).toBe('delete')
  })

  it('keeps it with --keep, and after a failure, with a one-line reminder', () => {
    for (const a of [afterDrill({ passed: true, fileName: JOB, keep: true }), afterDrill({ passed: false, fileName: JOB, keep: false })]) {
      expect(a.action).toBe('keep')
      expect(a.message).toMatch(/still there.*Delete it once you're done/)
      expect(a.message.split('\n')).toHaveLength(1)
    }
  })

  it('never deletes anything else, the Oct 9 dump included, pass or fail', () => {
    for (const fileName of [OCT9, 'ledger-manual-2026-10-12T101500Z.dump.age', 'ledger-2026-10-11T031704Z (1).dump.age']) {
      for (const passed of [true, false]) {
        const a = afterDrill({ passed, fileName, keep: false })
        expect(a.action, `${fileName} ${passed}`).toBe('keep')
        expect(a.message).toMatch(/never deletes it/)
      }
    }
  })
})

describe('the key prompt', () => {
  it('takes only an age secret key, and checks only its shape', () => {
    expect(looksLikeAgeIdentity(`AGE-SECRET-KEY-1${'Q'.repeat(58)}`)).toBe(true)
    for (const bad of ['', 'age1qqqq', `AGE-SECRET-KEY-1${'Q'.repeat(57)}`, `AGE-SECRET-KEY-1${'B'.repeat(58)}`, `AGE-SECRET-KEY-PQ-1${'Q'.repeat(58)}`]) {
      expect(looksLikeAgeIdentity(bad), bad.slice(0, 20)).toBe(false)
    }
  })
})

describe('judging a drill', () => {
  const base: TableCounts[] = [
    { table: 'User', restored: 2, productionThen: 2, productionNow: 2 },
    { table: 'AuditEvent', restored: 10, productionThen: 10, productionNow: 14 },
    { table: 'RecurringStream', restored: 5, productionThen: 5, productionNow: 5 },
    { table: 'SubscriptionMark', restored: 1, productionThen: 1, productionNow: 1 },
    { table: '_prisma_migrations', restored: 16, productionThen: 16, productionNow: 16 },
  ]
  const ctx = { hardDeletesSince: 0, strayInBackup: [], auditHealthy: true }
  const withTable = (table: string, over: Partial<TableCounts>) => base.map((c) => (c.table === table ? { ...c, ...over } : c))

  it('passes when the backup has everything production had by then', () => {
    expect(judgeDrill(base, ctx)).toEqual({ failures: [], warnings: [] })
  })

  it('fails when rows production had by then are missing', () => {
    expect(judgeDrill(withTable('User', { restored: 1 }), ctx).failures[0]).toMatch(/User: the backup has 1 row\(s\), production had at least 2/)
  })

  it('only notes extra rows, with why', () => {
    const v = judgeDrill(withTable('User', { restored: 3 }), { ...ctx, hardDeletesSince: 1 })
    expect(v.failures).toEqual([])
    expect(v.warnings[0]).toMatch(/1 more row.*1 unlink\(s\) or account deletion\(s\) since then/)
  })

  it('fails on a required table missing from the backup, or a table production has that the backup lacks', () => {
    for (const t of ['User', 'AuditEvent', 'RecurringStream', 'SubscriptionMark', '_prisma_migrations']) {
      expect(judgeDrill(withTable(t, { restored: null }), ctx).failures.join(), t).toMatch(new RegExp(`${t} is missing from the restored backup`))
    }
    expect(judgeDrill([...base, { table: 'Goal', restored: null, productionThen: 0, productionNow: 0 }], ctx).failures).toEqual(['Goal exists in production but not in the backup'])
  })

  it('fails when the audit log is not intact', () => {
    expect(judgeDrill(base, { ...ctx, auditHealthy: false }).failures).toHaveLength(1)
  })

  it('notes a table dropped since, and a stray table, without failing', () => {
    const v = judgeDrill([...base, { table: 'Budget_backup_m53', restored: 2, productionThen: null, productionNow: null }], { ...ctx, strayInBackup: ['Budget_backup_m53'] })
    expect(v.failures).toEqual([])
    expect(v.warnings).toHaveLength(2)
  })

  it('compares each table by its created column', () => {
    expect([createdColumnOf('AuditEvent'), createdColumnOf('_prisma_migrations'), createdColumnOf('Transaction')]).toEqual(['at', 'started_at', 'createdAt'])
  })
})

describe('after a real restore: who to delete again', () => {
  const key = Buffer.alloc(32, 7)
  const hash = (id: string) => createHmac('sha256', key).update(`user:${id}`).digest('hex')
  const restored = ['demo-user', 'audit-u1', 'audit-u2', 'audit-u3']

  it('matches the audit log by keyed hash, and Clerk by id', () => {
    const v = toDeleteAgain(restored, new Set([hash('audit-u2')]), hash, new Set(['audit-u3']))
    expect(v).toEqual([{ userId: 'audit-u2', reasons: ['audit log'] }, { userId: 'audit-u3', reasons: ['Clerk'] }])
  })

  it('names both reasons when both agree, and never the demo user', () => {
    const v = toDeleteAgain(restored, new Set([hash('audit-u2'), hash('demo-user')]), hash, new Set(['audit-u2', 'demo-user']))
    expect(v).toEqual([{ userId: 'audit-u2', reasons: ['audit log', 'Clerk'] }])
  })

  it('without the Clerk check, relies on the audit log alone', () => {
    expect(toDeleteAgain(restored, new Set(), hash, null)).toEqual([])
  })

  it('a hash under a different key matches nothing', () => {
    const other = (id: string) => createHmac('sha256', Buffer.alloc(32, 8)).update(`user:${id}`).digest('hex')
    expect(toDeleteAgain(restored, new Set([other('audit-u2')]), hash, null)).toEqual([])
  })
})

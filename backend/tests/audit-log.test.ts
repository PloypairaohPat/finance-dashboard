// ─────────────────────────────────────────────────────────────────
//  The audit log's table (M7.7 PR 1): its value limits, append-only from app
//  code, expiry only past retention, and kept out of every per-user table
//  list so it outlives the user. Nothing writes to it yet.
//
//  Rows can't be cleaned up (that's the point), so every assertion looks only
//  at rows this file created, by id. Hashes are random; nothing is real.
// ─────────────────────────────────────────────────────────────────

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import prisma from '../src/lib/prisma'
import {
  AUDIT_ACTORS, AUDIT_EVENTS, AUDIT_OUTCOMES, AUDIT_PLAID_RESULTS, AUDIT_RETENTION_DAYS,
} from '../src/lib/auditLog'
import { auditHealth } from '../scripts/lib/audit-triggers'
import { NON_DEMO_TABLES } from '../src/lib/userFingerprint'
import { DELETION_ORDER } from '../src/services/accountDeletion.service'
import { CREATE_ORDER, WIPE_ORDER } from '../prisma/demo-tables'

const hash = () => randomBytes(32).toString('hex')
const DAY = 86_400_000

/** A valid row, with overrides. */
const row = (over: Record<string, unknown> = {}) => ({ event: 'item.unlinked', actor: 'user', subject: hash(), ...over })
const add = (over: Record<string, unknown> = {}) => prisma.auditEvent.create({ data: row(over) as any })
const exists = async (id: bigint) => (await prisma.auditEvent.count({ where: { id } })) === 1

/** Insert a row dated `daysAgo`, past the trigger that stamps the insert time. Test database only. */
async function aged(daysAgo: number): Promise<bigint> {
  await prisma.$executeRawUnsafe('ALTER TABLE "AuditEvent" DISABLE TRIGGER audit_event_set_at')
  try {
    const [r] = await prisma.$queryRawUnsafe<Array<{ id: bigint }>>(
      `INSERT INTO "AuditEvent" (at, event, actor, subject) VALUES ((now() AT TIME ZONE 'UTC') - make_interval(days => $1::int), 'item.linked', 'user', $2) RETURNING id`,
      daysAgo, hash(),
    )
    return r.id
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "AuditEvent" ENABLE TRIGGER audit_event_set_at')
  }
}

/** The quoted values a CHECK (... IN (...)) constraint allows. */
async function allowed(constraint: string): Promise<string[]> {
  const [c] = await prisma.$queryRawUnsafe<Array<{ def: string }>>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`, constraint,
  )
  return [...c.def.matchAll(/'([^']+)'::text/g)].map((m) => m[1]).sort()
}

describe('value limits', () => {
  it('match the lists in src/lib/auditLog.ts exactly', async () => {
    expect(await allowed('AuditEvent_event_check')).toEqual([...AUDIT_EVENTS].sort())
    expect(await allowed('AuditEvent_actor_check')).toEqual([...AUDIT_ACTORS].sort())
    expect(await allowed('AuditEvent_plaidResult_check')).toEqual([...AUDIT_PLAID_RESULTS].sort())
    expect(await allowed('AuditEvent_outcome_check')).toEqual([...AUDIT_OUTCOMES].sort())
  })

  it('accept a full row, and stamp the insert time whatever "at" was sent', async () => {
    const r = await add({
      event: 'deletion.incomplete', plaidResult: 'failed', outcome: 'failed', stage: 'PLAID',
      errorCode: 'ITEM_NOT_FOUND', count: 2, itemRef: hash(), at: new Date(Date.now() - 900 * DAY),
    })
    expect(Math.abs(r.at.getTime() - Date.now())).toBeLessThan(60_000)
    expect(r.keyVersion).toBe(1)
  })

  it('refuse an unlisted event, actor, Plaid result or outcome', async () => {
    for (const bad of [{ event: 'item.renamed' }, { actor: 'admin' }, { plaidResult: 'gone' }, { outcome: 'success' }]) {
      await expect(add(bad), JSON.stringify(bad)).rejects.toThrow(/check constraint/)
    }
  })

  it('let stage and errorCode hold codes only: capitals, digits, underscores, and short', async () => {
    for (const ok of [{ stage: 'ROWS', errorCode: 'P2034' }, { stage: 'PLAID', errorCode: '40P01' }, { errorCode: 'X'.repeat(48) }, { stage: 'S'.repeat(32) }]) {
      await expect(add(ok), JSON.stringify(ok)).resolves.toBeTruthy()
    }
    for (const bad of [
      { errorCode: 'item not found' }, { errorCode: 'ITEM_NOT_FOUND: the token was revoked' }, { errorCode: 'item_not_found' },
      { errorCode: '' }, { errorCode: 'X'.repeat(49) }, { stage: 'rows' }, { stage: 'S'.repeat(33) },
    ]) {
      await expect(add(bad), JSON.stringify(bad)).rejects.toThrow(/check constraint/)
    }
  })

  it('take people, Items and sessions as 64-character lowercase hex only', async () => {
    for (const bad of [
      { subject: 'invented-user-id' }, { subject: hash().toUpperCase() }, { subject: hash().slice(1) },
      { itemRef: 'invented-item-id' }, { event: 'session.first_seen', sessionRef: 'invented-session' },
    ]) {
      await expect(add(bad), JSON.stringify(bad).slice(0, 60)).rejects.toThrow(/check constraint/)
    }
  })

  it('need a person unless Plaid is the actor, and a session hash on session.first_seen only', async () => {
    await expect(add({ subject: null })).rejects.toThrow(/check constraint/)
    await expect(add({ actor: 'plaid', event: 'item.permission_revoked', subject: null, itemRef: hash() })).resolves.toBeTruthy()
    await expect(add({ event: 'session.first_seen' })).rejects.toThrow(/check constraint/)
    await expect(add({ sessionRef: hash() })).rejects.toThrow(/check constraint/)
    await expect(add({ event: 'session.first_seen', sessionRef: hash() })).resolves.toBeTruthy()
    await expect(add({ count: -1 })).rejects.toThrow(/check constraint/)
    await expect(add({ keyVersion: 0 })).rejects.toThrow(/check constraint/)
  })
})

describe('append-only, from app code', () => {
  it('refuses UPDATE, through Prisma and raw SQL, and leaves the row as it was', async () => {
    const r = await add({ outcome: 'ok' })
    await expect(prisma.auditEvent.update({ where: { id: r.id }, data: { outcome: 'failed' } })).rejects.toThrow(/append-only: UPDATE refused/)
    await expect(prisma.auditEvent.updateMany({ where: { id: r.id }, data: { subject: hash() } })).rejects.toThrow(/append-only/)
    await expect(prisma.$executeRawUnsafe(`UPDATE "AuditEvent" SET at = at - interval '500 days' WHERE id = $1`, r.id)).rejects.toThrow(/append-only/)
    expect(await prisma.auditEvent.findUniqueOrThrow({ where: { id: r.id } })).toEqual(r)
  })

  it('refuses DELETE of a row inside retention, through Prisma and raw SQL', async () => {
    const r = await add()
    await expect(prisma.auditEvent.delete({ where: { id: r.id } })).rejects.toThrow(/append-only: DELETE refused/)
    await expect(prisma.auditEvent.deleteMany({ where: { id: r.id } })).rejects.toThrow(/append-only/)
    await expect(prisma.$executeRawUnsafe('DELETE FROM "AuditEvent" WHERE id = $1', r.id)).rejects.toThrow(/append-only/)
    expect(await exists(r.id)).toBe(true)
  })

  it('refuses TRUNCATE', async () => {
    const r = await add()
    await expect(prisma.$executeRawUnsafe('TRUNCATE "AuditEvent"')).rejects.toThrow(/append-only: TRUNCATE refused/)
    expect(await exists(r.id)).toBe(true)
  })

  it(`lets expiry delete a row past ${AUDIT_RETENTION_DAYS} days, and nothing younger`, async () => {
    const old = await aged(AUDIT_RETENTION_DAYS + 1)
    const young = await aged(AUDIT_RETENTION_DAYS - 1)
    await expect(prisma.auditEvent.delete({ where: { id: young } })).rejects.toThrow(/append-only/)
    // One statement over both: the young row refuses, so neither goes.
    await expect(prisma.auditEvent.deleteMany({ where: { id: { in: [old, young] } } })).rejects.toThrow(/append-only/)
    expect(await exists(old)).toBe(true)
    await prisma.auditEvent.delete({ where: { id: old } })
    expect(await exists(old)).toBe(false)
    expect(await exists(young)).toBe(true)
  })

  it('reports every trigger present and enabled, every limit in place, and the retention matching', async () => {
    const h = await auditHealth(prisma)
    expect(h.triggers.filter((t) => !t.ok)).toEqual([])
    expect(h.missingChecks).toEqual([])
    expect(h.retentionMatches).toBe(true)
  })
})

describe('outlives the user', () => {
  it('is in none of the per-user table lists, has no userId and no foreign key', async () => {
    expect(NON_DEMO_TABLES.map(([t]) => t)).not.toContain('AuditEvent')
    expect(DELETION_ORDER.map(([t]) => t)).not.toContain('AuditEvent')
    expect(WIPE_ORDER).not.toContain('auditEvent')
    expect(CREATE_ORDER).not.toContain('auditEvent')

    const schema = readFileSync(path.resolve(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8')
    const model = schema.match(/^model AuditEvent \{([\s\S]*?)^\}/m)
    expect(model).not.toBeNull()
    expect(model![1]).not.toMatch(/\buserId\b|@relation/)

    const fks = await prisma.$queryRawUnsafe<unknown[]>(
      `SELECT conname FROM pg_constraint WHERE contype = 'f' AND (conrelid = '"AuditEvent"'::regclass OR confrelid = '"AuditEvent"'::regclass)`,
    )
    expect(fks).toEqual([])
  })
})

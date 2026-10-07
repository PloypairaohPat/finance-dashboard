// ─────────────────────────────────────────────────────────────────
//  The audit log's writes (M7.7 PR 2): every event at its code path, the
//  key, the session dedup, expiry, the summary script's lookup, and the one
//  rule over all of it: the log never blocks what it records, and a failed
//  write reaches Sentry with the event name only.
//
//  Rows can't be cleaned up (append-only), so every id here carries a
//  per-run random suffix and assertions read only that run's subjects.
//  All ids are invented.
// ─────────────────────────────────────────────────────────────────

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sentry = vi.hoisted(() => ({ captureMessage: vi.fn(), captureException: vi.fn() }))
vi.mock('@sentry/node', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sentry/node')>()),
  captureMessage: sentry.captureMessage,
  captureException: sentry.captureException,
}))
const verify = vi.hoisted(() => ({ ok: true }))
vi.mock('../src/utils/verifyPlaidWebhook', () => ({ verifyPlaidWebhook: vi.fn(async () => verify.ok) }))

import { createHash, createHmac, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import request from 'supertest'
import { clerkClient } from '@clerk/express'
import { app, plaidClient } from '../src/app'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'
import { auditHash, loadAuditHashKey } from '../src/lib/auditKey'
import {
  AUDIT_RETENTION_DAYS, AUDIT_WRITE_FAILED, auditCode, expireAuditEvents, forgetSeenSessions, recordAudit, recordSessionSeen,
} from '../src/lib/auditLog'
import { DeletionError, DeletionUnderway, deleteUserData } from '../src/services/accountDeletion.service'
import { askLookup, onlyKnownArgs } from '../scripts/lib/audit-lookup'

const RUN = randomBytes(4).toString('hex')
const U = (n: string) => `audit-w-${RUN}-${n}`
const DAY = 86_400_000
const BACKEND = path.resolve(__dirname, '..')

const clerk = clerkClient.users as unknown as Record<'banUser' | 'unbanUser' | 'deleteUser', ReturnType<typeof vi.fn>>
const mock = (name: string) => (plaidClient as any)[name] as ReturnType<typeof vi.fn>
const plaidError = (code: string) => Object.assign(new Error('plaid'), { response: { data: { error_code: code } } })

type Seen = { event: string; actor: string; plaidResult?: string; outcome?: string; stage?: string; errorCode?: string; count?: number }
const compact = (r: any): Seen => Object.fromEntries(
  Object.entries({ event: r.event, actor: r.actor, plaidResult: r.plaidResult, outcome: r.outcome, stage: r.stage, errorCode: r.errorCode, count: r.count })
    .filter(([, v]) => v !== null && v !== undefined),
) as Seen

/** This person's events, oldest first. */
const eventsOf = async (userId: string) =>
  (await prisma.auditEvent.findMany({ where: { subject: auditHash('user', userId) }, orderBy: { id: 'asc' } })).map(compact)
/** This Plaid item_id's events, oldest first. */
const eventsOfItem = async (itemId: string) =>
  (await prisma.auditEvent.findMany({ where: { itemRef: auditHash('item', itemId) }, orderBy: { id: 'asc' } })).map(compact)

/** Every insert into the table fails while `fn` runs: a real database error. Test database only. */
async function withAuditWritesFailing<T>(fn: () => Promise<T>): Promise<T> {
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION audit_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit test: insert refused'; END $$`)
  await prisma.$executeRawUnsafe(`CREATE TRIGGER audit_test_fail BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION audit_test_fail()`)
  try {
    return await fn()
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER audit_test_fail ON "AuditEvent"`)
  }
}

/** Deleting this Item's row fails while `fn` runs (the unlink's row transaction). Test database only. */
async function withItemRowsUndeletable<T>(fn: () => Promise<T>): Promise<T> {
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION audit_test_keep_item() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit test: item delete refused'; END $$`)
  await prisma.$executeRawUnsafe(`CREATE TRIGGER audit_test_keep_item BEFORE DELETE ON "PlaidItem" FOR EACH ROW EXECUTE FUNCTION audit_test_keep_item()`)
  try {
    return await fn()
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER audit_test_keep_item ON "PlaidItem"`)
  }
}

const writeFailures = () => sentry.captureMessage.mock.calls.filter((c) => c[0] === AUDIT_WRITE_FAILED)

/** Poll for a write the request didn't wait for. */
async function eventually<T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  let v = await read()
  for (let i = 0; i < 40 && !done(v); i++) {
    await new Promise((r) => setTimeout(r, 50))
    v = await read()
  }
  return v
}

const users = new Set<string>()
async function makeUser(n: string, opts: { items?: number } = {}) {
  const id = U(n)
  users.add(id)
  await prisma.user.create({ data: { id, email: `${id}@audit-test.local` } })
  const items = []
  for (let i = 1; i <= (opts.items ?? 1); i++) {
    const item = await prisma.plaidItem.create({ data: { userId: id, itemId: `${id}-item-${i}`, accessToken: encrypt(`access-${id}-${i}`), institutionName: 'Audit Test Bank' } })
    await prisma.account.create({ data: { userId: id, plaidItemId: item.id, plaidAccountId: `${id}-acct-${i}`, name: 'Checking', type: 'depository', isoCurrencyCode: 'USD' } })
    items.push(item)
  }
  return { id, items }
}

async function wipe(id: string) {
  for (const t of ['subscriptionMark', 'transaction', 'account', 'recurringStream', 'plaidItem', 'budget', 'balanceSnapshot', 'alert', 'goal'] as const) {
    await (prisma[t] as any).deleteMany({ where: { userId: id } })
  }
  await prisma.user.deleteMany({ where: { id } })
}

beforeEach(() => {
  verify.ok = true
  for (const f of Object.values(clerk)) { f.mockReset(); f.mockResolvedValue({}) }
  for (const [name, value] of Object.entries({
    itemPublicTokenExchange: { data: { access_token: 'test-access-token', item_id: 'test-item-id' } },
    itemGet: { data: { item: { institution_id: null } } },
    accountsGet: { data: { accounts: [] } },
    itemRemove: { data: {} },
  })) { mock(name).mockReset(); mock(name).mockResolvedValue(value) }
  sentry.captureMessage.mockClear(); sentry.captureException.mockClear()
})
afterEach(async () => { for (const id of users) await wipe(id) })
afterAll(async () => { for (const id of users) await wipe(id) })

describe('the key', () => {
  const good = 'ef'.repeat(32)

  it('takes exactly 64 hex characters, checked before decoding, and never echoes the value', () => {
    expect(loadAuditHashKey(good, 'ab'.repeat(32))).toHaveLength(32)
    expect(loadAuditHashKey(good.toUpperCase(), 'ab'.repeat(32))).toHaveLength(32)
    const refused: Array<[string | undefined, RegExp]> = [
      [undefined, /not set/], ['', /not set/],
      [good.slice(2), /exactly 64 hex characters.*got 62/], [`${good}ef`, /got 66/],
      [`${good.slice(1)}g`, /only hexadecimal/], [`${good.slice(1)} `, /only hexadecimal/],
      // Buffer.from(hex) would silently drop an odd last character: length first would still catch it, but hex is checked first.
      [good.slice(1), /exactly 64/],
    ]
    for (const [raw, message] of refused) {
      let err: Error | undefined
      try { loadAuditHashKey(raw, 'ab'.repeat(32)) } catch (e) { err = e as Error }
      expect(err?.message, String(raw)).toMatch(message)
      if (raw) expect(err!.message).not.toContain(raw)
    }
  })

  it('is refused when it equals ENCRYPTION_KEY', () => {
    expect(() => loadAuditHashKey('ab'.repeat(32), 'AB'.repeat(32))).toThrow(/not ENCRYPTION_KEY/)
  })

  it('is checked at startup and required, like ENCRYPTION_KEY', () => {
    const appTs = readFileSync(path.join(BACKEND, 'src', 'app.ts'), 'utf8')
    expect(appTs).toMatch(/'AUDIT_HASH_KEY',\s*\]/)
    expect(appTs).toMatch(/try \{\s*auditHashKey\(\)\s*\} catch[\s\S]{0,120}process\.exit\(1\)/)
  })

  it('makes keyed hashes: not a plain SHA-256, different per kind, and never the id', () => {
    const id = U('hash')
    const h = auditHash('user', id)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(h).toBe(createHmac('sha256', Buffer.from(process.env.AUDIT_HASH_KEY!, 'hex')).update(`user:${id}`).digest('hex'))
    expect(h).not.toBe(createHash('sha256').update(`user:${id}`).digest('hex'))
    expect(h).not.toBe(createHash('sha256').update(id).digest('hex'))
    expect(auditHash('item', id)).not.toBe(h)
  })
})

describe('codes', () => {
  it('keep a code, and turn anything else into OTHER so the row still lands', () => {
    expect(auditCode('ITEM_NOT_FOUND')).toBe('ITEM_NOT_FOUND')
    expect(auditCode('P2034')).toBe('P2034')
    expect(auditCode(null)).toBeNull()
    expect(auditCode('the token was revoked')).toBe('OTHER')
    expect(auditCode('item_not_found')).toBe('OTHER')
    expect(auditCode('X'.repeat(49))).toBe('OTHER')
  })
})

describe('linking', () => {
  function nextLink(userId: string, n: number, accounts: Array<{ mask: string }> = [{ mask: '0001' }], institutionId: string | null = null) {
    const itemId = `${userId}-new-${n}`
    mock('itemPublicTokenExchange').mockResolvedValueOnce({ data: { access_token: `access-new-${userId}-${n}`, item_id: itemId } })
    mock('itemGet').mockResolvedValueOnce({ data: { item: { institution_id: institutionId } } })
    mock('accountsGet').mockResolvedValueOnce({
      data: { accounts: accounts.map((a, i) => ({ account_id: `${itemId}-acct-${i}`, name: 'Checking', official_name: null, mask: a.mask, type: 'depository', subtype: 'checking', balances: { current: 1, available: 1, iso_currency_code: 'USD' } })) },
    })
    return itemId
  }
  const link = (userId: string) => request(app).post('/exchange_public_token').set('X-Test-User', userId).send({ public_token: 'public-test' })

  it('records item.linked, with the Item as a hash and no raw id anywhere in the row', async () => {
    const { id } = await makeUser('link', { items: 0 })
    const itemId = nextLink(id, 1)
    expect((await link(id)).status).toBe(200)
    expect(await eventsOfItem(itemId)).toEqual([{ event: 'item.linked', actor: 'user', outcome: 'ok' }])
    const row = await prisma.auditEvent.findFirstOrThrow({ where: { itemRef: auditHash('item', itemId) } })
    expect(JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toMatch(new RegExp(`${id}|${itemId}`))
    expect(row.subject).toBe(auditHash('user', id))
  })

  it('records a duplicate discarded after exchange, with Plaid removal', async () => {
    const { id } = await makeUser('dup', { items: 0 })
    await prisma.plaidItem.create({ data: { userId: id, itemId: `${id}-old`, accessToken: encrypt('access-old'), institutionId: 'ins_audit', institutionName: 'B' } })
      .then((item) => prisma.account.create({ data: { userId: id, plaidItemId: item.id, plaidAccountId: `${id}-old-acct`, name: 'Checking', mask: '0001', type: 'depository', subtype: 'checking', isoCurrencyCode: 'USD' } }))
    const itemId = nextLink(id, 1, [{ mask: '0001' }], 'ins_audit')
    expect((await link(id)).status).toBe(409)
    expect(await eventsOfItem(itemId)).toEqual([{ event: 'item.link_discarded', actor: 'user', outcome: 'duplicate', plaidResult: 'removed' }])
  })

  it('records a failed link whose Item Plaid wouldn’t remove, and that case still reaches Sentry', async () => {
    const { id } = await makeUser('stuck', { items: 0 })
    const itemId = `${id}-new-1`
    mock('itemPublicTokenExchange').mockResolvedValueOnce({ data: { access_token: 'access-stuck', item_id: itemId } })
    mock('itemGet').mockRejectedValueOnce(new Error('item/get down'))
    mock('itemRemove').mockRejectedValueOnce(plaidError('INTERNAL_SERVER_ERROR'))
    expect((await link(id)).status).toBe(500)
    expect(await eventsOfItem(itemId)).toEqual([
      { event: 'item.link_discarded', actor: 'user', outcome: 'failed', plaidResult: 'failed', errorCode: 'INTERNAL_SERVER_ERROR' },
    ])
    expect(sentry.captureMessage.mock.calls.map((c) => c[0])).toContain('plaid.link: a just-exchanged Item could not be removed; report it to Plaid by item_id')
  })

  it('records an Item exchanged but never stored', async () => {
    const { id } = await makeUser('nostore', { items: 0 })
    const other = await makeUser('nostore-other', { items: 0 })
    const itemId = `${id}-taken`
    // The item_id is already stored (for someone else), so storing it fails.
    await prisma.plaidItem.create({ data: { userId: other.id, itemId, accessToken: encrypt('x'), institutionName: 'B' } })
    mock('itemPublicTokenExchange').mockResolvedValueOnce({ data: { access_token: 'access-nostore', item_id: itemId } })
    expect((await link(id)).status).toBe(500)
    expect(await eventsOf(id)).toEqual([{ event: 'item.link_discarded', actor: 'user', outcome: 'failed', plaidResult: 'removed' }])
  })
})

describe('unlinking', () => {
  const unlink = (userId: string, rowId: string) => request(app).delete(`/plaid-items/${rowId}`).set('X-Test-User', userId)

  it('records Plaid removed it and our rows went', async () => {
    const { id, items } = await makeUser('unlink')
    expect((await unlink(id, items[0].id)).status).toBe(200)
    expect(await eventsOfItem(items[0].itemId)).toEqual([{ event: 'item.unlinked', actor: 'user', plaidResult: 'removed', outcome: 'ok' }])
  })

  it('records Plaid saying it was already gone', async () => {
    const { id, items } = await makeUser('gone')
    mock('itemRemove').mockRejectedValueOnce(plaidError('ITEM_NOT_FOUND'))
    expect((await unlink(id, items[0].id)).status).toBe(200)
    expect(await eventsOfItem(items[0].itemId)).toEqual([{ event: 'item.unlinked', actor: 'user', plaidResult: 'already_gone', outcome: 'ok' }])
  })

  it('records Plaid refusing, and nothing else happened', async () => {
    const { id, items } = await makeUser('refused')
    mock('itemRemove').mockRejectedValueOnce(plaidError('INTERNAL_SERVER_ERROR'))
    expect((await unlink(id, items[0].id)).status).toBe(500)
    expect(await eventsOfItem(items[0].itemId)).toEqual([{ event: 'item.unlinked', actor: 'user', plaidResult: 'failed', errorCode: 'INTERNAL_SERVER_ERROR' }])
    expect(await prisma.plaidItem.count({ where: { id: items[0].id } })).toBe(1)
  })

  it('records Plaid removed it but our rows failed, then the retry that finishes it', async () => {
    const { id, items } = await makeUser('half')
    await withItemRowsUndeletable(async () => expect((await unlink(id, items[0].id)).status).toBe(500))
    mock('itemRemove').mockRejectedValueOnce(plaidError('ITEM_NOT_FOUND'))
    expect((await unlink(id, items[0].id)).status).toBe(200)
    // The row transaction's error carries no Prisma code here, so no errorCode.
    expect(await eventsOfItem(items[0].itemId)).toEqual([
      { event: 'item.unlinked', actor: 'user', plaidResult: 'removed', outcome: 'failed' },
      { event: 'item.unlinked', actor: 'user', plaidResult: 'already_gone', outcome: 'ok' },
    ])
  })

  it('still unlinks when the log can’t be written, and Sentry gets the event name only', async () => {
    const { id, items } = await makeUser('nolog')
    await withAuditWritesFailing(async () => expect((await unlink(id, items[0].id)).status).toBe(200))
    expect(await prisma.plaidItem.count({ where: { id: items[0].id } })).toBe(0)
    // The event name and Prisma's code (none for a raw database error): nothing else.
    expect(writeFailures()).toEqual([[AUDIT_WRITE_FAILED, { level: 'error', extra: { event: 'item.unlinked', prismaCode: null } }]])
    expect(JSON.stringify(writeFailures())).not.toMatch(new RegExp(`${id}|${items[0].itemId}`))
  })
})

describe('Plaid revocation webhooks', () => {
  const webhook = (body: object) => request(app).post('/webhook').set('Plaid-Verification', 'test').send(body)
  // The handler answers Plaid first and works after, so wait for the row.
  const rowsFor = (itemId: string) => eventually(
    () => prisma.auditEvent.findMany({ where: { itemRef: auditHash('item', itemId) } }), (r) => r.length > 0,
  )

  it('USER_PERMISSION_REVOKED: item.permission_revoked, Plaid as actor, the Item hash only; the handler still marks it revoked', async () => {
    const { items } = await makeUser('perm')
    await webhook({ webhook_type: 'ITEM', webhook_code: 'USER_PERMISSION_REVOKED', item_id: items[0].itemId, error: { error_code: 'USER_PERMISSION_REVOKED' } })
    const rows = await rowsFor(items[0].itemId)
    expect(rows.map(compact)).toEqual([{ event: 'item.permission_revoked', actor: 'plaid' }])
    expect(rows[0].subject).toBeNull()
    const status = await eventually(async () => (await prisma.plaidItem.findUniqueOrThrow({ where: { id: items[0].id } })).status, (s) => s === 'revoked')
    expect(status).toBe('revoked')
  })

  it('USER_ACCOUNT_REVOKED: item.account_revoked, and nothing else changes', async () => {
    const { items } = await makeUser('acct')
    const before = await prisma.plaidItem.findUniqueOrThrow({ where: { id: items[0].id } })
    await webhook({ webhook_type: 'ITEM', webhook_code: 'USER_ACCOUNT_REVOKED', item_id: items[0].itemId, account_id: `${items[0].itemId}-acct` })
    const rows = await rowsFor(items[0].itemId)
    await new Promise((r) => setTimeout(r, 200)) // anything else the handler might do, given time
    expect(rows.map(compact)).toEqual([{ event: 'item.account_revoked', actor: 'plaid' }])
    expect(rows[0].subject).toBeNull()
    expect(await prisma.plaidItem.findUniqueOrThrow({ where: { id: items[0].id } })).toEqual(before)
    expect(sentry.captureMessage).not.toHaveBeenCalled()
  })

  it('records nothing for a webhook that fails verification', async () => {
    verify.ok = false
    const itemId = U('forged-item')
    expect((await webhook({ webhook_type: 'ITEM', webhook_code: 'USER_PERMISSION_REVOKED', item_id: itemId })).status).toBe(401)
    await new Promise((r) => setTimeout(r, 200))
    expect(await eventsOfItem(itemId)).toEqual([])
  })
})

describe('account deletion', () => {
  const deps = (extra: object = {}) => ({ plaidClient, clerk: clerkClient.users as any, ...extra })

  it('records requested then completed, and the rows outlive the user', async () => {
    const { id } = await makeUser('del')
    await deleteUserData(id, deps())
    expect(await prisma.user.count({ where: { id } })).toBe(0)
    expect(await eventsOf(id)).toEqual([
      { event: 'deletion.requested', actor: 'user' },
      { event: 'deletion.completed', actor: 'user', outcome: 'ok', count: 1 },
    ])
  })

  it('records delete-user.ts as the operator, and a Clerk deletion still pending', async () => {
    const { id } = await makeUser('op')
    clerk.deleteUser.mockRejectedValueOnce(Object.assign(new Error('clerk down'), { status: 500 }))
    await deleteUserData(id, deps({ actor: 'operator' }))
    expect(await eventsOf(id)).toEqual([
      { event: 'deletion.requested', actor: 'operator' },
      { event: 'deletion.completed', actor: 'operator', outcome: 'clerk_pending', count: 1 },
    ])
    expect(readFileSync(path.join(BACKEND, 'scripts', 'delete-user.ts'), 'utf8')).toMatch(/deleteUserData\(userId, \{[^}]*actor: 'operator'/)
  })

  it('records a stop at the ban', async () => {
    const { id } = await makeUser('ban')
    clerk.banUser.mockRejectedValueOnce(Object.assign(new Error('clerk down'), { status: 500 }))
    await expect(deleteUserData(id, deps())).rejects.toThrow('clerk down')
    expect(await eventsOf(id)).toEqual([{ event: 'deletion.requested', actor: 'user' }, { event: 'deletion.stopped', actor: 'user', stage: 'BAN' }])
  })

  it('records a stop at Plaid, before anything irreversible', async () => {
    const { id } = await makeUser('stopplaid')
    mock('itemRemove').mockRejectedValueOnce(plaidError('INTERNAL_SERVER_ERROR'))
    await expect(deleteUserData(id, deps())).rejects.toBeInstanceOf(DeletionError)
    expect(await eventsOf(id)).toEqual([
      { event: 'deletion.requested', actor: 'user' },
      { event: 'deletion.stopped', actor: 'user', stage: 'PLAID', errorCode: 'INTERNAL_SERVER_ERROR' },
    ])
  })

  it('records incomplete at Plaid once an Item has gone, with how many', async () => {
    const { id } = await makeUser('incplaid', { items: 2 })
    mock('itemRemove').mockResolvedValueOnce({ data: {} }).mockRejectedValueOnce(plaidError('INTERNAL_SERVER_ERROR'))
    await expect(deleteUserData(id, deps())).rejects.toBeInstanceOf(DeletionUnderway)
    expect(await eventsOf(id)).toEqual([
      { event: 'deletion.requested', actor: 'user' },
      { event: 'deletion.incomplete', actor: 'user', stage: 'PLAID', errorCode: 'INTERNAL_SERVER_ERROR', count: 1 },
    ])
  })

  it('records incomplete at the rows, and a stop at the rows when nothing had left Plaid', async () => {
    const boom = { hooks: { beforeDelete: async () => { throw new Error('rows down') } } }
    const withItem = await makeUser('incrows')
    await expect(deleteUserData(withItem.id, deps(boom))).rejects.toBeInstanceOf(DeletionUnderway)
    expect((await eventsOf(withItem.id)).slice(1)).toEqual([{ event: 'deletion.incomplete', actor: 'user', stage: 'ROWS', errorCode: 'ERROR', count: 1 }])

    const noItems = await makeUser('stoprows', { items: 0 })
    await expect(deleteUserData(noItems.id, deps(boom))).rejects.toBeInstanceOf(DeletionError)
    expect((await eventsOf(noItems.id)).slice(1)).toEqual([{ event: 'deletion.stopped', actor: 'user', stage: 'ROWS', errorCode: 'ERROR' }])
  })

  it('still deletes when the log can’t be written, and each failure reaches Sentry by event name', async () => {
    const { id } = await makeUser('dellog')
    const report = await withAuditWritesFailing(() => deleteUserData(id, deps()))
    expect(report.clerkDeleted).toBe(true)
    expect(await prisma.user.count({ where: { id } })).toBe(0)
    expect(writeFailures().map((c) => c[1].extra.event)).toEqual(['deletion.requested', 'deletion.completed'])
    expect(JSON.stringify(writeFailures())).not.toContain(id)
  })
})

describe('sessions', () => {
  const load = (userId: string, sessionId?: string) => {
    const r = request(app).get('/plaid-items').set('X-Test-User', userId)
    return sessionId ? r.set('X-Test-Session', sessionId) : r
  }
  const sessionRows = (sessionId: string) => prisma.auditEvent.findMany({ where: { sessionRef: auditHash('session', sessionId) } })

  it('records a session the first time the backend sees it, once, even across a restart', async () => {
    const { id } = await makeUser('sess', { items: 0 })
    const sid = U('session-1')
    expect((await load(id, sid)).status).toBe(200)
    const rows = await eventually(() => sessionRows(sid), (r) => r.length > 0)
    expect(rows.map(compact)).toEqual([{ event: 'session.first_seen', actor: 'user' }])
    expect(rows[0].subject).toBe(auditHash('user', id))
    await load(id, sid)
    forgetSeenSessions() // as a restart, or another instance, would
    await load(id, sid)
    await recordSessionSeen(id, sid)
    expect(await sessionRows(sid)).toHaveLength(1)
    expect(writeFailures()).toEqual([])
  })

  it('records nothing for demo requests or a request without a session id', async () => {
    const { id } = await makeUser('nosess', { items: 0 })
    await request(app).get('/plaid-items').set('X-Demo-Mode', '1').set('X-Test-Session', U('demo-session'))
    await load(id)
    await new Promise((r) => setTimeout(r, 200))
    expect(await eventsOf(id)).toEqual([])
    expect(await sessionRows(U('demo-session'))).toEqual([])
  })

  it('doesn’t hold up or fail the request when the write fails; Sentry gets it, and the next request tries again', async () => {
    const { id } = await makeUser('sessfail', { items: 0 })
    const sid = U('session-2')
    await withAuditWritesFailing(async () => {
      expect((await load(id, sid)).status).toBe(200)
      await eventually(async () => writeFailures().length, (n) => n > 0)
    })
    expect(writeFailures().map((c) => c[1].extra)).toEqual([{ event: 'session.first_seen', prismaCode: null }])
    expect(await sessionRows(sid)).toEqual([])
    await load(id, sid)
    expect(await eventually(() => sessionRows(sid), (r) => r.length > 0)).toHaveLength(1)
  })
})

describe('expiry', () => {
  it(`deletes rows past ${AUDIT_RETENTION_DAYS} days and nothing younger; the nightly job runs it`, async () => {
    const subject = auditHash('user', U('expiry'))
    const insertAged = async (daysAgo: number) => {
      await prisma.$executeRawUnsafe('ALTER TABLE "AuditEvent" DISABLE TRIGGER audit_event_set_at')
      try {
        const [r] = await prisma.$queryRawUnsafe<Array<{ id: bigint }>>(
          `INSERT INTO "AuditEvent" (at, event, actor, subject) VALUES ((now() AT TIME ZONE 'UTC') - make_interval(days => $1::int), 'item.linked', 'user', $2) RETURNING id`,
          daysAgo, subject,
        )
        return r.id
      } finally {
        await prisma.$executeRawUnsafe('ALTER TABLE "AuditEvent" ENABLE TRIGGER audit_event_set_at')
      }
    }
    const old = await insertAged(AUDIT_RETENTION_DAYS + 2)
    const young = await insertAged(AUDIT_RETENTION_DAYS - 2)
    expect(await expireAuditEvents()).toBeGreaterThanOrEqual(1)
    expect(await prisma.auditEvent.count({ where: { id: old } })).toBe(0)
    expect(await prisma.auditEvent.count({ where: { id: young } })).toBe(1)
    const scheduler = readFileSync(path.join(BACKEND, 'src', 'scheduler.ts'), 'utf8')
    expect(scheduler).toMatch(/cron\.schedule\("0 0 \* \* \*"[\s\S]*await expireAuditEvents\(\)/)
  })
})

describe('who touches the table', () => {
  /** Every .ts file under these folders, relative to backend/. */
  const tsFiles = (dir: string): string[] => readdirSync(path.join(BACKEND, dir)).flatMap((f) => {
    const rel = path.posix.join(dir, f)
    if (statSync(path.join(BACKEND, rel)).isDirectory()) return f === 'node_modules' ? [] : tsFiles(rel)
    return rel.endsWith('.ts') ? [rel] : []
  })
  const TOUCH = /\.auditEvent\b|"AuditEvent"/

  it('only the audit log’s write and expiry functions and the summary script read or write it', () => {
    const touching = ['src', 'scripts', 'prisma'].flatMap(tsFiles).filter((f) => TOUCH.test(readFileSync(path.join(BACKEND, f), 'utf8')))
    expect(touching.sort()).toEqual(['scripts/audit-log-summary.ts', 'scripts/lib/audit-triggers.ts', 'src/lib/auditLog.ts'])

    // In auditLog.ts, only these functions.
    const src = readFileSync(path.join(BACKEND, 'src/lib/auditLog.ts'), 'utf8')
    const fns = [...src.matchAll(/^(?:export )?(?:async )?function (\w+)[\s\S]*?^\}/gm)]
    expect(fns.filter((m) => TOUCH.test(m[0])).map((m) => m[1]).sort()).toEqual(['expireAuditEvents', 'recordAudit', 'recordSessionSeen'])
    expect(src.replace(/^(?:export )?(?:async )?function \w+[\s\S]*?^\}/gm, '')).not.toMatch(TOUCH)

    // The summary's trigger-health helper reads the catalogue, never the rows.
    const triggers = readFileSync(path.join(BACKEND, 'scripts/lib/audit-triggers.ts'), 'utf8')
    expect([...triggers.matchAll(/"AuditEvent"[^\n]*/g)].every((m) => m[0].startsWith(`"AuditEvent"'::regclass`))).toBe(true)
  })
})

describe('the summary script', () => {
  const tsx = path.join(BACKEND, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const run = (args: string[], input = '', env: NodeJS.ProcessEnv = process.env) =>
    spawnSync(process.execPath, [tsx, 'scripts/audit-log-summary.ts', ...args], { cwd: BACKEND, input, env, encoding: 'utf8', timeout: 60_000 })

  it('asks for the id at a prompt; never takes it from the command line', async () => {
    const { Readable, PassThrough } = await import('node:stream')
    const out = new PassThrough()
    const saved = process.argv
    process.argv = [...saved.slice(0, 2), '--lookup', '--id', 'from-argv']
    try {
      expect(await askLookup(Readable.from(['a\n', 'from-prompt\n']), out)).toEqual({ kind: 'user', id: 'from-prompt' })
    } finally {
      process.argv = saved
    }
    expect(await askLookup(Readable.from(['i\n', 'an-item\n']), out)).toEqual({ kind: 'item', id: 'an-item' })
    expect(await askLookup(Readable.from(['x\n']), out)).toBeNull()
    expect(onlyKnownArgs(['--allow-remote', 'db.example', '--lookup'])).toBe(true)
    expect(onlyKnownArgs(['--lookup', 'audit-w-someone'])).toBe(false)
    expect(onlyKnownArgs(['--lookup', '--id=audit-w-someone'])).toBe(false)
  })

  it('looks up an account and an Item from the prompt, printing their events but never the id or hash', async () => {
    const id = U('lookup')
    const itemId = U('lookup-item')
    await recordAudit({ event: 'item.linked', actor: 'user', userId: id, itemId, outcome: 'ok' })
    await recordAudit({ event: 'deletion.requested', actor: 'operator', userId: id })

    const byUser = run(['--lookup'], `a\n${id}\n`)
    expect(byUser.status, byUser.stderr).toBe(0)
    expect(byUser.stdout).toMatch(/2 event\(s\) for that account/)
    expect(byUser.stdout).toMatch(/item\.linked\s+user\s+outcome=ok/)
    expect(byUser.stdout).toMatch(/deletion\.requested\s+operator/)
    expect(byUser.stdout).not.toContain(id)
    expect(byUser.stdout).not.toContain(auditHash('user', id))

    const byItem = run(['--lookup'], `i\n${itemId}\n`)
    expect(byItem.stdout).toMatch(/1 event\(s\) for that bank connection/)
    expect(byItem.stdout).not.toContain(itemId)
  }, 120_000)

  it('refuses an id on the command line, unread and unechoed', () => {
    const id = U('argv')
    const r = run(['--lookup', id], `a\n${U('prompt')}\n`)
    expect(r.status).toBe(1)
    expect(r.stdout + r.stderr).toMatch(/unexpected arguments/)
    expect(r.stdout + r.stderr).not.toContain(id)
    expect(r.stdout).not.toMatch(/event\(s\) for/)
  }, 60_000)

  it('reports a missing table as a problem, exit 2, not a stack trace', () => {
    // A schema with no tables in it: the connection resolves "AuditEvent" to nothing.
    const at = (raw: string) => { const u = new URL(raw); u.searchParams.set('schema', `audit_missing_${RUN}`); return u.toString() }
    const env = { ...process.env, DATABASE_URL: at(process.env.DATABASE_URL!), DIRECT_URL: at(process.env.DIRECT_URL ?? process.env.DATABASE_URL!) }
    const r = run([], '', env)
    expect(r.status).toBe(2)
    expect(r.stdout).toMatch(/PROBLEM\s+the AuditEvent table does not exist/)
    expect(r.stderr).not.toMatch(/at \w+ \(|Error:/)
  }, 60_000)
})

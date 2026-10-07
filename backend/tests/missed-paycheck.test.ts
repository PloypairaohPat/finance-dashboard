// ─────────────────────────────────────────────────────────────────
//  The missed-paycheck alert (M7.6 PR 6b), against every rule in
//  docs/m7.6-missed-paycheck.md. Real data has never had a late payday, so
//  these are the only proof it fires when it should and never when it
//  shouldn't. All names, ids, amounts and dates are invented.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import request from 'supertest'
import type { Alert } from '@prisma/client'
import { app, plaidClient as appPlaidClient } from '../src/app'
import { plaidClient as libPlaidClient } from '../src/lib/plaidClient'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'
import { runDetectors } from '../src/services/alerts/dispatcher'
import { loadPaycheckInput } from '../src/services/missedPaycheck.service'
import {
  GRACE_BANKING_DAYS, judgePaychecks, type PaycheckInput, type PaycheckRow, type PaycheckStream,
} from '../src/lib/missedPaycheck'
import { DEMO_ACCOUNTS, buildDemoDataset } from '../prisma/demo-dataset'

const D = (iso: string) => new Date(`${iso}T00:00:00Z`)
const at = (iso: string) => new Date(`${iso}T12:00:00Z`)

// ── the rules, pure ───────────────────────────────────────────────
//
// A biweekly payday on Fridays: 4 Sep, 18 Sep, 2 Oct 2026 paid; next 16 Oct.
// Its deadline is 2 banking days on: Tuesday 20 Oct. It fires from Wednesday 21.

const ACCT = 'acct-checking'
const PLAID_ACCT = 'FAKE-plaid-acct-checking'
const ITEM = 'item-1'
const usualPay = 1000

function stream(o: Partial<PaycheckStream> = {}): PaycheckStream {
  return {
    plaidItemId: ITEM, plaidAccountId: PLAID_ACCT, accountId: ACCT, accountName: 'Everyday Checking',
    payer: 'ACME PAYROLL', frequency: 'BIWEEKLY', predictedNextDate: D('2026-10-16'),
    deposits: ['2026-09-04', '2026-09-18', '2026-10-02'].map((d, i) => ({ id: `dep-${i}`, date: D(d), amount: -usualPay })),
    ...o,
  }
}
const fresh = (iso = '2026-12-31') => ({ lastSyncedAt: at(iso), streamsRefreshedAt: at(iso), status: 'healthy' })
function input(o: { streams?: PaycheckStream[]; item?: ReturnType<typeof fresh>; enabled?: boolean } = {}): PaycheckInput {
  return { enabled: o.enabled ?? true, streams: o.streams ?? [stream()], items: new Map([[ITEM, o.item ?? fresh()]]) }
}
const row = (iso: string, amount: number, o: Partial<PaycheckRow> = {}): PaycheckRow => ({
  id: `row-${iso}-${amount}`, accountId: ACCT, date: D(iso), amount, categoryDetailed: 'INCOME_SALARY', verdict: { kind: 'income' }, ...o,
})
const judge = (now: string, o: { input?: PaycheckInput; rows?: PaycheckRow[]; active?: Map<string, Alert> } = {}) =>
  judgePaychecks({ input: o.input ?? input(), rows: o.rows ?? [], activeAlerts: o.active ?? new Map(), now: at(now) })

describe('timing', () => {
  it(`fires only after the deadline: the payday plus ${GRACE_BANKING_DAYS} banking days`, () => {
    expect(judge('2026-10-20')).toEqual([]) // the deadline itself: pay may still land today
    const [a] = judge('2026-10-21')
    expect(a).toMatchObject({
      kind: 'missed_paycheck', severity: 'medium', fingerprint: `missed_paycheck:${PLAID_ACCT}:2026-10-16`,
      title: "Your paycheck from ACME PAYROLL hasn't arrived",
    })
    expect(a.body).toContain('Fri 16 Oct')
    expect(a.body).toContain('Everyday Checking')
  })

  it('pay moved early for a weekend is on time', () => {
    // Monthly on the 15th; 15 Nov 2026 is a Sunday, paid Friday the 13th.
    const monthly = stream({
      frequency: 'MONTHLY', predictedNextDate: D('2026-11-15'),
      deposits: ['2026-08-14', '2026-09-15', '2026-10-15'].map((d, i) => ({ id: `m-${i}`, date: D(d), amount: -usualPay })),
    })
    expect(judge('2026-11-20', { input: input({ streams: [monthly] }), rows: [row('2026-11-13', -usualPay)] })).toEqual([])
    // Without it: the deadline is Monday 16th + 2 banking days, Wednesday 18th.
    expect(judge('2026-11-18', { input: input({ streams: [monthly] }) })).toEqual([])
    expect(judge('2026-11-19', { input: input({ streams: [monthly] }) })).toHaveLength(1)
  })

  it('a Federal Reserve holiday shifts the deadline', () => {
    // Payday Friday 9 Oct 2026; Monday 12 Oct is Columbus Day, so the deadline is Wednesday 14th.
    const s = stream({ predictedNextDate: D('2026-10-09'), deposits: ['2026-09-11', '2026-09-25'].map((d, i) => ({ id: `h-${i}`, date: D(d), amount: -usualPay })) })
    expect(judge('2026-10-14', { input: input({ streams: [s] }) })).toEqual([])
    expect(judge('2026-10-15', { input: input({ streams: [s] }) })).toHaveLength(1)
  })
})

describe('what counts as arrived', () => {
  it('a paycheck well above usual (a bonus) counts', () => {
    expect(judge('2026-10-21', { rows: [row('2026-10-16', -3 * usualPay)] })).toEqual([])
  })

  it('one under half the usual amount does not; half exactly does', () => {
    expect(judge('2026-10-21', { rows: [row('2026-10-16', -usualPay * 49 / 100)] })).toHaveLength(1)
    expect(judge('2026-10-21', { rows: [row('2026-10-16', -usualPay / 2)] })).toEqual([])
  })

  it('interest, or a transfer in, on payday does not count', () => {
    const interest = row('2026-10-16', -usualPay, { categoryDetailed: 'INCOME_INTEREST_EARNED' })
    const transferIn = row('2026-10-16', -usualPay, { categoryDetailed: 'TRANSFER_IN_ACCOUNT_TRANSFER', verdict: { kind: 'internal_transfer' } })
    expect(judge('2026-10-21', { rows: [interest, transferIn] })).toHaveLength(1)
  })

  it("another paycheck stream's deposit does not count: one employer's pay can't hide the other's", () => {
    const main = stream({ payer: 'MAIN JOB', predictedNextDate: D('2026-10-30'), deposits: [{ id: 'main-1', date: D('2026-10-16'), amount: -2500 }] })
    // The main job's pay lands on the side job's payday; the side job's doesn't.
    expect(judge('2026-10-21', { input: input({ streams: [stream(), main] }), rows: [row('2026-10-16', -2500, { id: 'main-1' })] })).toHaveLength(1)
    // A new salary deposit no stream has claimed yet still counts.
    expect(judge('2026-10-21', { rows: [row('2026-10-16', -usualPay, { id: 'unclaimed' })] })).toEqual([])
  })

  it('a deposit into another account does not count', () => {
    expect(judge('2026-10-21', { rows: [row('2026-10-16', -usualPay, { accountId: 'acct-savings' })] })).toHaveLength(1)
  })
})

describe('stale data', () => {
  it('held back when the Item last synced before the deadline had passed', () => {
    const item = { ...fresh(), lastSyncedAt: at('2026-10-20') }
    expect(judge('2026-10-23', { input: input({ item }) })).toEqual([])
  })

  it('held back when the streams were last refreshed before it', () => {
    const item = { ...fresh(), streamsRefreshedAt: at('2026-10-20') }
    expect(judge('2026-10-23', { input: input({ item }) })).toEqual([])
  })

  it('held back when the Item is unhealthy', () => {
    expect(judge('2026-10-23', { input: input({ item: { ...fresh(), status: 'login_required' } }) })).toEqual([])
  })

  it('an alert already raised stays while the data is behind', () => {
    const [raised] = judge('2026-10-21')
    const active = new Map([[raised.fingerprint, { fingerprint: raised.fingerprint } as Alert]])
    const behind = input({ item: { ...fresh(), lastSyncedAt: at('2026-10-19') } })
    expect(judge('2026-10-23', { input: behind, active }).map((a) => a.fingerprint)).toEqual([raised.fingerprint])
  })
})

describe('one alert per account and payday', () => {
  it('two salary streams paying one account on one day raise one alert', () => {
    const second = stream({ payer: 'OTHER PAYROLL', deposits: stream().deposits.map((d) => ({ ...d, id: `b-${d.id}` })) })
    expect(judge('2026-10-21', { input: input({ streams: [stream(), second] }) })).toHaveLength(1)
  })

  it('at the next payday it moves on: the missed one resolves, the new one waits for its own deadline', () => {
    expect(judge('2026-10-30')).toEqual([]) // 30 Oct is the next payday
    const [next] = judge('2026-11-04')
    expect(next.fingerprint).toBe(`missed_paycheck:${PLAID_ACCT}:2026-10-30`)
  })

  it('with the setting off, nothing', () => {
    expect(judge('2026-10-21', { input: input({ enabled: false }) })).toEqual([])
  })
})

// ── through the database: qualification, resolution, isolation ───

const A = 'missed-pay-test-user-a'
const B = 'missed-pay-test-user-b'
const DAY = 86_400_000
const now = new Date()
const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
const ago = (d: number) => new Date(today - d * DAY)

interface World { userId: string; itemId: string; accountId: string; n: number }
const w: Record<string, World> = {}

async function wipe(id: string) {
  for (const t of ['alert', 'recurringStream', 'balanceSnapshot', 'transaction', 'account', 'plaidItem'] as const) {
    await (prisma[t] as any).deleteMany({ where: { userId: id } })
  }
  await prisma.user.deleteMany({ where: { id } })
}

async function world(userId: string, enabled = true): Promise<World> {
  await prisma.user.create({ data: { id: userId, email: `${userId}@missed-pay-test.local`, missedPaycheckAlerts: enabled } })
  const item = await prisma.plaidItem.create({
    data: { userId, itemId: `${userId}-item`, accessToken: encrypt(`fake-${userId}`), institutionName: 'Test Bank', lastSyncedAt: new Date(), streamsRefreshedAt: new Date() },
  })
  const account = await prisma.account.create({
    data: { userId, plaidItemId: item.id, plaidAccountId: `${userId}-acct`, name: 'Checking', type: 'depository', subtype: 'checking', isoCurrencyCode: 'USD' },
  })
  return { userId, itemId: item.id, accountId: account.id, n: 0 }
}

async function deposit(x: World, daysAgo: number, o: { amount?: number; pending?: boolean; detailed?: string } = {}) {
  const plaidTransactionId = `${x.userId}-dep-${++x.n}`
  const detailed = o.detailed ?? 'INCOME_SALARY'
  const primary = detailed.startsWith('TRANSFER_IN') ? 'TRANSFER_IN' : 'INCOME'
  await prisma.transaction.create({
    data: {
      userId: x.userId, accountId: x.accountId, plaidTransactionId, date: ago(daysAgo), amount: (o.amount ?? -1500).toFixed(2),
      name: 'ACME PAYROLL', cleanName: 'ACME PAYROLL', categoryPrimary: primary, categoryDetailed: detailed,
      pending: o.pending ?? false, isoCurrencyCode: 'USD',
      rawJson: { personal_finance_category: { primary, detailed, confidence_level: 'VERY_HIGH' }, counterparties: [] },
    },
  })
  return plaidTransactionId
}

/** Paid 49, 35 and 21 days ago, biweekly; the payday 7 days ago never came. Always past its deadline. */
async function overdueStream(x: World, o: { detailed?: string; status?: string; isActive?: boolean; frequency?: string; ids?: string[] } = {}) {
  const ids = o.ids ?? [await deposit(x, 49, o), await deposit(x, 35, o), await deposit(x, 21, o)]
  return prisma.recurringStream.create({
    data: {
      userId: x.userId, plaidItemId: x.itemId, streamId: `FAKE-${x.userId}-${++x.n}`, plaidAccountId: `${x.userId}-acct`,
      direction: 'inflow', description: 'ACME PAYROLL', merchantName: 'ACME PAYROLL',
      pfcPrimary: (o.detailed ?? 'INCOME_SALARY').startsWith('TRANSFER_IN') ? 'TRANSFER_IN' : 'INCOME', pfcDetailed: o.detailed ?? 'INCOME_SALARY',
      frequency: o.frequency ?? 'BIWEEKLY', status: o.status ?? 'MATURE', isActive: o.isActive ?? true,
      firstDate: ago(49), lastDate: ago(21), predictedNextDate: ago(7), plaidTransactionIds: ids, plaidUpdatedAt: new Date(),
    },
  })
}

const missed = (userId: string) => prisma.alert.findMany({ where: { userId, kind: 'missed_paycheck' }, orderBy: { fingerprint: 'asc' } })

describe('the bell', () => {
  beforeEach(async () => { await wipe(A); await wipe(B); w.a = await world(A) })
  afterAll(async () => { await wipe(A); await wipe(B) })

  it('raises it for an overdue salary stream, and resolves it when pay arrives', async () => {
    await overdueStream(w.a)
    await runDetectors(A)
    const [alert] = await missed(A)
    expect(alert).toMatchObject({ severity: 'medium', resolvedAt: null })
    expect(alert.fingerprint).toBe(`missed_paycheck:${A}-acct:${ago(7).toISOString().slice(0, 10)}`)
    await deposit(w.a, 1)
    await runDetectors(A)
    expect((await missed(A))[0].resolvedAt).not.toBeNull()
  })

  it('a pending deposit counts as arrived', async () => {
    await overdueStream(w.a)
    await deposit(w.a, 0, { pending: true })
    await runDetectors(A)
    expect(await missed(A)).toEqual([])
  })

  it('resolves when the setting is turned off', async () => {
    await overdueStream(w.a)
    await runDetectors(A)
    expect((await missed(A))[0].resolvedAt).toBeNull()
    await prisma.user.update({ where: { id: A }, data: { missedPaycheckAlerts: false } })
    await runDetectors(A)
    expect((await missed(A))[0].resolvedAt).not.toBeNull()
  })

  it.each<[string, Parameters<typeof overdueStream>[1]]>([
    ['interest', { detailed: 'INCOME_INTEREST_EARNED' }],
    ['transfers in', { detailed: 'TRANSFER_IN_ACCOUNT_TRANSFER' }],
    ['irregular income (no fixed frequency)', { frequency: 'UNKNOWN' }],
    ['a stream not yet established', { status: 'EARLY_DETECTION' }],
    ['an inactive stream', { isActive: false }],
    ['an annual one', { frequency: 'ANNUALLY' }],
  ])('never fires for %s', async (_, o) => {
    await overdueStream(w.a, o)
    await runDetectors(A)
    expect(await missed(A)).toEqual([])
  })

  it('never fires with the setting off', async () => {
    await prisma.user.update({ where: { id: A }, data: { missedPaycheckAlerts: false } })
    await overdueStream(w.a)
    await runDetectors(A)
    expect(await missed(A)).toEqual([])
  })

  it("reads only the user's own rows and streams", async () => {
    w.b = await world(B)
    const bIds = [await deposit(w.b, 49), await deposit(w.b, 35), await deposit(w.b, 21)]
    // A's stream names B's deposits: none resolve, so A's stream has nothing to judge by.
    await overdueStream(w.a, { ids: bIds })
    const input = await loadPaycheckInput(A)
    expect(input.streams.flatMap((s) => s.deposits)).toEqual([])
    // B's own overdue stream raises B's alert, never A's.
    await overdueStream(w.b, { ids: bIds })
    await runDetectors(A)
    await runDetectors(B)
    expect(JSON.stringify(await missed(A))).not.toContain(B)
    expect(await missed(B)).toHaveLength(1)
  })

  it('the bell calls no Plaid endpoint', async () => {
    await overdueStream(w.a)
    const fns = [appPlaidClient, libPlaidClient].flatMap((c) =>
      Object.values(c as unknown as Record<string, unknown>).filter((f): f is Mock => vi.isMockFunction(f)))
    fns.forEach((f) => f.mockClear())
    void libPlaidClient.itemGet({ access_token: 'self-check' })
    expect(fns.reduce((n, f) => n + f.mock.calls.length, 0)).toBe(1) // the counter can see a call
    fns.forEach((f) => f.mockClear())
    expect((await request(app).get('/alerts').set('X-Test-User', A)).status).toBe(200)
    expect(fns.reduce((n, f) => n + f.mock.calls.length, 0)).toBe(0)
    expect(await missed(A)).toHaveLength(1)
  })
})

// ── the demo, at every build date across a year ───────────────────

describe('the demo', () => {
  it('its overdue second job fires at every build date across a year, and its on-time salary never does', () => {
    const plaidAccountOf = new Map(DEMO_ACCOUNTS.map((a) => [a.key, a.plaidAccountId]))
    const failures: string[] = []
    for (let day = 0; day < 366; day++) {
      const built = new Date(Date.UTC(2026, 0, 1 + day, 15))
      const ds = buildDemoDataset(built)
      const tx = new Map(ds.transactions.map((t) => [t.plaidTransactionId, t]))
      const paychecks = ds.streams.filter((s) => s.paycheck)
      const streams: PaycheckStream[] = paychecks.map((s) => ({
        plaidItemId: 'demo', plaidAccountId: plaidAccountOf.get(s.accountKey)!, accountId: s.accountKey, accountName: s.accountKey,
        payer: s.streamId, frequency: s.frequency as PaycheckStream['frequency'],
        predictedNextDate: s.predictedNextDate ? D(s.predictedNextDate) : null,
        deposits: s.txIds.map((id) => ({ id, date: D(tx.get(id)!.date), amount: tx.get(id)!.amount })),
      }))
      const rows: PaycheckRow[] = ds.transactions.map((t) => ({
        id: t.plaidTransactionId, accountId: t.accountKey, date: D(t.date), amount: t.amount, categoryDetailed: t.detailed, verdict: { kind: t.expected.kind },
      }))
      // The seed stamps the demo's Items at the build time.
      const alerts = judgePaychecks({
        input: { enabled: true, streams, items: new Map([['demo', { lastSyncedAt: built, streamsRefreshedAt: built, status: 'healthy' }]]) },
        rows, activeAlerts: new Map(), now: built,
      })
      const fired = alerts.map((a) => a.data?.payer)
      const expected = paychecks.filter((s) => s.paycheck === 'overdue').map((s) => s.streamId)
      if (JSON.stringify(fired) !== JSON.stringify(expected)) failures.push(`${built.toISOString().slice(0, 10)}: ${JSON.stringify(fired)}`)
    }
    expect(failures).toEqual([])
  })
})

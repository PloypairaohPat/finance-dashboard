// ─────────────────────────────────────────────────────────────────
//  recurringStreams.service — refresh one Item's stored recurring streams
//  (M7.6 PR 2a). Nothing in the app calls it yet: no webhook, no scheduler, no
//  page load. The backfill script is its only caller until PR 2b.
//
//  Two parts that compose:
//    fetch  — one /transactions/recurring/get for an Item, mapped through
//             lib/recurringStreams. No database writes.
//    apply  — inside a transaction it's given, for one Item, under the
//             per-user lock: upsert by (Item, stream_id), delete the Item's
//             streams Plaid didn't return, and leave out streams on accounts
//             we don't hold.
//  planItemStreams is the one definition of what apply would do; the
//  backfill's dry run prints it, apply executes it.
//
//  Only a successful response changes anything. A Plaid error leaves the
//  Item's streams as they were and goes to Sentry, as sync failures do. A
//  successful empty response is real, and clears the Item's streams.
//
//  Both refuse the demo user and demo Items (the demo has no Plaid Items).
// ─────────────────────────────────────────────────────────────────

import * as Sentry from '@sentry/node'
import type { PlaidApi } from 'plaid'
import type { Prisma, PrismaClient, StreamDirection } from '@prisma/client'
import defaultPrisma from '../lib/prisma'
import { DEMO_USER_ID } from '../middleware/auth'
import { decrypt } from '../utils/encrypt'
import { lockUserRows } from '../lib/userLock'
import { streamColumns, type PlaidStream } from '../lib/recurringStreams'

/** The demo seed's Items carry this instead of a token: nothing to fetch. */
export const DEMO_ITEM_TOKEN = 'DEMO-NO-TOKEN'

export class RefreshRefused extends Error {}

/** Plaid refused the call. Nothing was written. */
export class StreamFetchError extends Error {
  constructor(public readonly errorCode: string) {
    super(`recurring streams fetch failed (${errorCode})`)
  }
}

function assertRefreshable(userId: string, accessToken?: string) {
  if (userId === DEMO_USER_ID) throw new RefreshRefused('The demo user has no Plaid Items to refresh.')
  if (accessToken === DEMO_ITEM_TOKEN) throw new RefreshRefused('A demo Item has no Plaid Item to refresh.')
}

export interface FetchedStreams {
  plaidItemId: string
  userId: string
  plaidUpdatedAt: Date
  streams: Array<{ direction: StreamDirection; stream: PlaidStream }>
}

type ItemForFetch = { id: string; userId: string; itemId: string; accessToken: string }

/** One /transactions/recurring/get for an Item. No database writes. */
export async function fetchItemStreams(plaidClient: PlaidApi, item: ItemForFetch): Promise<FetchedStreams> {
  assertRefreshable(item.userId, item.accessToken)
  let data: { inflow_streams?: PlaidStream[]; outflow_streams?: PlaidStream[]; updated_datetime?: string }
  try {
    // No account_ids: every stream comes back, and apply leaves out those on
    // accounts we don't hold, so the rule lives in one place and is visible.
    const res = await plaidClient.transactionsRecurringGet({ access_token: decrypt(item.accessToken) })
    // Through our local type: plaid 24.0.0's has no predicted_next_date.
    data = res.data as unknown as typeof data
  } catch (err: any) {
    const errorCode = err?.response?.data?.error_code ?? 'NO_PLAID_ERROR_CODE'
    // As sync failures are reported. The scrubber keeps tokens out of the event.
    Sentry.captureException(err, { extra: { itemId: item.itemId, errorCode, during: 'recurring streams refresh' } })
    throw new StreamFetchError(errorCode)
  }
  return {
    plaidItemId: item.id,
    userId: item.userId,
    plaidUpdatedAt: data.updated_datetime ? new Date(data.updated_datetime) : new Date(),
    streams: [
      ...(data.inflow_streams ?? []).map((stream) => ({ direction: 'inflow' as const, stream })),
      ...(data.outflow_streams ?? []).map((stream) => ({ direction: 'outflow' as const, stream })),
    ],
  }
}

type Db = PrismaClient | Prisma.TransactionClient

export interface StreamPlan {
  /** The Item is gone (unlinked, discarded, or its user deleted): nothing to do. */
  itemGone: boolean
  upserts: Array<ReturnType<typeof streamColumns>>
  /** Stored streams of this Item that Plaid didn't return (or are on accounts we don't hold). */
  removeStreamIds: string[]
  /** Returned streams left out because their account isn't one we hold. */
  droppedForAccounts: number
}

/** What apply would do for one Item. Reads only. */
export async function planItemStreams(db: Db, fetched: FetchedStreams): Promise<StreamPlan> {
  const item = await db.plaidItem.findFirst({
    where: { id: fetched.plaidItemId, userId: fetched.userId },
    select: { id: true, accounts: { select: { plaidAccountId: true } } },
  })
  if (!item) return { itemGone: true, upserts: [], removeStreamIds: [], droppedForAccounts: 0 }

  const held = new Set(item.accounts.map((a) => a.plaidAccountId))
  const kept = fetched.streams.filter((s) => held.has(s.stream.account_id))
  const upserts = kept.map((s) => streamColumns(s.stream, {
    userId: fetched.userId, plaidItemId: item.id, direction: s.direction, plaidUpdatedAt: fetched.plaidUpdatedAt,
  }))
  const keptIds = new Set(upserts.map((u) => u.streamId))
  const stored = await db.recurringStream.findMany({
    where: { plaidItemId: item.id, userId: fetched.userId },
    select: { streamId: true },
  })
  return {
    itemGone: false,
    upserts,
    removeStreamIds: stored.map((s) => s.streamId).filter((id) => !keptIds.has(id)),
    droppedForAccounts: fetched.streams.length - kept.length,
  }
}

export interface ApplyResult {
  skipped: boolean
  written: number
  removed: number
  droppedForAccounts: number
}

/** Apply a fetch to one Item, inside the transaction given, under the per-user lock. */
export async function applyItemStreams(tx: Prisma.TransactionClient, fetched: FetchedStreams): Promise<ApplyResult> {
  assertRefreshable(fetched.userId)
  await lockUserRows(tx, fetched.userId)
  const item = await tx.plaidItem.findFirst({ where: { id: fetched.plaidItemId, userId: fetched.userId }, select: { accessToken: true } })
  if (item) assertRefreshable(fetched.userId, item.accessToken)

  // Planned under the lock, so the Item can't vanish between plan and write.
  const plan = await planItemStreams(tx, fetched)
  if (plan.itemGone) return { skipped: true, written: 0, removed: 0, droppedForAccounts: 0 }

  for (const cols of plan.upserts) {
    const { userId, plaidItemId, streamId, ...changeable } = cols
    await tx.recurringStream.upsert({
      where: { plaidItemId_streamId: { plaidItemId, streamId } },
      create: cols,
      update: changeable,
    })
  }
  const { count: removed } = plan.removeStreamIds.length > 0
    ? await tx.recurringStream.deleteMany({
      where: { plaidItemId: fetched.plaidItemId, userId: fetched.userId, streamId: { in: plan.removeStreamIds } },
    })
    : { count: 0 }
  // A successful refresh, an empty one included: the first refresh fires once
  // (M7.6 PR 2b-2), and the Plaid-items inventory shows a stalled one. Raw SQL
  // so only this column changes: Prisma's update would also bump updatedAt,
  // and a refresh isn't an edit to the Item (the backfill's check relies on it).
  await tx.$executeRaw`UPDATE "PlaidItem" SET "streamsRefreshedAt" = now() WHERE id = ${fetched.plaidItemId}`
  return { skipped: false, written: plan.upserts.length, removed, droppedForAccounts: plan.droppedForAccounts }
}

/**
 * Refresh one Item: fetch, then apply in a transaction. A Plaid error throws
 * StreamFetchError before any write. Not called by the app until PR 2b.
 */
export async function refreshItemStreams(
  plaidClient: PlaidApi,
  plaidItemRowId: string,
  db: PrismaClient = defaultPrisma,
): Promise<ApplyResult> {
  const item = await db.plaidItem.findUnique({
    where: { id: plaidItemRowId },
    select: { id: true, userId: true, itemId: true, accessToken: true },
  })
  if (!item) return { skipped: true, written: 0, removed: 0, droppedForAccounts: 0 }
  const fetched = await fetchItemStreams(plaidClient, item)
  return db.$transaction((tx) => applyItemStreams(tx, fetched))
}

// ── Triggers (M7.6 PR 2b-2) ───────────────────────────────────────
//
// The only callers of refreshItemStreams in the app: Plaid's webhooks and the
// daily backstop. Never a page load or a user action. Each handles its own
// errors and never throws, so a webhook handler or the scheduler can call it
// and move on: a Plaid error was already reported by fetchItemStreams, the
// demo is skipped quietly, and anything else goes to Sentry.

/** An Item not refreshed for this long is due for the daily backstop. */
export const STREAMS_STALE_HOURS = 20

export type TriggerOutcome = 'refreshed' | 'unknown' | 'not due' | 'skipped' | 'failed'

function reportRefreshFailure(err: unknown, plaidItemId: string, during: string): TriggerOutcome {
  if (err instanceof RefreshRefused) return 'skipped'
  if (!(err instanceof StreamFetchError)) {
    Sentry.captureException(err, { extra: { plaidItemId, during } })
  }
  return 'failed'
}

async function refreshAndReport(plaidClient: PlaidApi, plaidItemRowId: string, during: string, db: PrismaClient): Promise<TriggerOutcome> {
  try {
    const r = await refreshItemStreams(plaidClient, plaidItemRowId, db)
    return r.skipped ? 'unknown' : 'refreshed'
  } catch (err) {
    return reportRefreshFailure(err, plaidItemRowId, during)
  }
}

/** RECURRING_TRANSACTIONS_UPDATE: refresh the Item Plaid named, and only it. An unknown id is a quiet no-op. */
export async function refreshOnRecurringUpdate(
  plaidClient: PlaidApi,
  plaidItemId: string,
  db: PrismaClient = defaultPrisma,
): Promise<TriggerOutcome> {
  const item = await db.plaidItem.findUnique({ where: { itemId: plaidItemId }, select: { id: true } })
  if (!item) return 'unknown'
  return refreshAndReport(plaidClient, item.id, 'RECURRING_TRANSACTIONS_UPDATE', db)
}

/**
 * A new link's first refresh. Called after the sync that a SYNC_UPDATES_AVAILABLE
 * webhook with historical_update_complete started has finished, so the
 * streams' transactions are already in our rows. Only while the Item has
 * never been refreshed: Plaid keeps sending historical_update_complete: true
 * on later webhooks, and streamsRefreshedAt makes this fire once.
 */
export async function firstRefreshIfNeeded(
  plaidClient: PlaidApi,
  plaidItemRowId: string,
  db: PrismaClient = defaultPrisma,
): Promise<TriggerOutcome> {
  const item = await db.plaidItem.findUnique({ where: { id: plaidItemRowId }, select: { streamsRefreshedAt: true } })
  if (!item) return 'unknown'
  if (item.streamsRefreshedAt) return 'not due'
  return refreshAndReport(plaidClient, plaidItemRowId, 'first refresh', db)
}

/**
 * The daily backstop: every non-demo Item never refreshed, or not refreshed in
 * STREAMS_STALE_HOURS, in case a webhook was missed (our Items have pointed at
 * a dead webhook URL before). One Item's failure is reported and the rest carry on.
 */
export async function refreshStaleItems(
  plaidClient: PlaidApi,
  now: Date = new Date(),
  db: PrismaClient = defaultPrisma,
): Promise<{ due: number; refreshed: number; failed: number }> {
  const cutoff = new Date(now.getTime() - STREAMS_STALE_HOURS * 3_600_000)
  const due = await db.plaidItem.findMany({
    where: {
      userId: { not: DEMO_USER_ID },
      accessToken: { not: DEMO_ITEM_TOKEN },
      OR: [{ streamsRefreshedAt: null }, { streamsRefreshedAt: { lt: cutoff } }],
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })
  let refreshed = 0, failed = 0
  for (const item of due) {
    const outcome = await refreshAndReport(plaidClient, item.id, 'daily backstop', db)
    if (outcome === 'refreshed') refreshed++
    else if (outcome === 'failed') failed++
  }
  return { due: due.length, refreshed, failed }
}

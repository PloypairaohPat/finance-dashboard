// ─────────────────────────────────────────────────────────────────
//  services/plaidSync.ts
//  Reusable sync function — called by both the /transactions route
//  and the /webhook handler. Uses /transactions/sync (cursor-based
//  delta fetching) instead of re-fetching everything every time.
// ─────────────────────────────────────────────────────────────────

import { PlaidApi } from 'plaid'
import prisma        from '../lib/prisma'
import { decrypt }   from '../utils/encrypt'
import { cleanTransactions } from './cleaner'
import { captureBalanceSnapshots } from "./networth.service"
import { runDetectors } from "./alerts/dispatcher"
import { entityColumns } from '../lib/entityColumns'

/** How long a sync may wait for a connection to start its transaction. */
const SYNC_TX_MAX_WAIT_MS = 15_000
/**
 * A sync's transaction timeout: a base plus a budget per write, capped.
 * Measured locally at a few ms per upsert; 20 ms each leaves room for a remote
 * database. A 3,000-row first sync gets 90 s; the cap is 10 minutes.
 */
export function syncTimeoutMs(writes: number): number {
  return Math.min(30_000 + writes * 20, 600_000)
}

async function syncTransactions(plaidClient: PlaidApi, plaidItemId: string) {
  const item = await prisma.plaidItem.findUnique({
    where: { id: plaidItemId },
  });

  if (!item) throw new Error(`PlaidItem not found: ${plaidItemId}`);

  const access_token = decrypt(item.accessToken);
  let   cursor       = item.cursor ?? null;

  let added:    any[] = [];
  let modified: any[] = [];
  let removed:  any[] = [];
  let hasMore  = true;

  while (hasMore) {
    const response = await plaidClient.transactionsSync({
      access_token,
      cursor: cursor ?? undefined,
      count: 500,
    });

    const data = response.data;
    added    = added.concat(data.added);
    modified = modified.concat(data.modified);
    removed  = removed.concat(data.removed);
    hasMore  = data.has_more;
    cursor   = data.next_cursor;
  }

  // ── Write the sync: one transaction, rows and cursor together ───
  //
  // Every page is fetched above before anything is written, so the
  // transaction never waits on Plaid. Rows and cursor commit together or not
  // at all: a write that fails leaves the old cursor, and the next sync
  // fetches the same changes again. Before this, a failure part-way kept the
  // rows written so far while the cursor stayed behind, and an adding sync
  // and its removals were separate writes, so a read in between could count
  // a posting charge twice (pending and posted both live).
  //
  // Accounts are looked up once, outside the transaction: one query per row
  // inside it, not two. The timeout scales with the work, so a first sync
  // pulling a full history fits, and is capped so a stuck one still ends.
  const accounts = await prisma.account.findMany({
    where:  { plaidItemId },
    select: { id: true, plaidAccountId: true },
  });
  const accountId = new Map(accounts.map((a) => [a.plaidAccountId, a.id]));
  const writes = added.length + modified.length + removed.length;

  await prisma.$transaction(async (tx) => {
    // ── ADDED ──────────────────────────────────────────────────────
    for (const txn of added) {
      const account = accountId.get(txn.account_id);
      if (!account) continue;

      await tx.transaction.upsert({
        where:  { plaidTransactionId: txn.transaction_id },
        update: {
          pending:          txn.pending,
          amount:           txn.amount,
          merchantName:     txn.merchant_name                       ?? null,
          categoryPrimary:  txn.personal_finance_category?.primary  ?? null,
          categoryDetailed: txn.personal_finance_category?.detailed ?? null,
          ...entityColumns(txn),
        },
        create: {
          userId:             item.userId,
          accountId:          account,
          plaidTransactionId: txn.transaction_id,
          amount:             txn.amount,
          isoCurrencyCode:    txn.iso_currency_code                 ?? null,
          date:               new Date(txn.date),
          name:               txn.name,
          merchantName:       txn.merchant_name                     ?? null,
          categoryPrimary:    txn.personal_finance_category?.primary  ?? null,
          categoryDetailed:   txn.personal_finance_category?.detailed ?? null,
          pending:            txn.pending,
          ...entityColumns(txn),
          rawJson:            txn,
        },
      });
    }

    // ── MODIFIED ───────────────────────────────────────────────────
    for (const txn of modified) {
      await tx.transaction.updateMany({
        where: { plaidTransactionId: txn.transaction_id },
        data: {
          pending:          txn.pending,
          amount:           txn.amount,
          merchantName:     txn.merchant_name                       ?? null,
          categoryPrimary:  txn.personal_finance_category?.primary  ?? null,
          categoryDetailed: txn.personal_finance_category?.detailed ?? null,
          // From the modified payload: rawJson keeps the payload the row was
          // created from, so these columns are the only current copy of the ids.
          ...entityColumns(txn),
        },
      });
    }

    // ── REMOVED: soft-deleted ──────────────────────────────────────
    if (removed.length > 0) {
      await tx.transaction.updateMany({
        where: { plaidTransactionId: { in: removed.map((r) => r.transaction_id) } },
        data:  { deletedAt: new Date() },
      });
    }

    // ── Cursor + lastSyncedAt, in the same transaction ─────────────
    await tx.plaidItem.update({
      where: { id: plaidItemId },
      data:  { cursor, lastSyncedAt: new Date() },
    });
  }, {
    maxWait: SYNC_TX_MAX_WAIT_MS,
    timeout: syncTimeoutMs(writes),
  });

  console.log(
    `✅ Sync complete — added: ${added.length}, ` +
    `modified: ${modified.length}, removed: ${removed.length}`
  );

  // ── Clean after every sync ────────────────────────────────────
  const clean = await cleanTransactions(prisma, item.userId)
  console.log(`   🧹 cleaned: ${clean.normalized} names, ${clean.resolved} pending resolved`)

  // ── Capture balance snapshot after sync ───────────────────────
  await captureBalanceSnapshots(item.userId)

  // ── Run alert detectors after sync ───────────────────────────
  await runDetectors(item.userId)

  return {
    added:    added.length,
    modified: modified.length,
    removed:  removed.length,
  };
}

export { syncTransactions };
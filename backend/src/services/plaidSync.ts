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

async function syncTransactions(plaidClient: PlaidApi, plaidItemId: string) {
  // Load PlaidItem from DB to get the cursor + encrypted token
  const item = await prisma.plaidItem.findUnique({
    where: { id: plaidItemId },
  });

  if (!item) throw new Error(`PlaidItem not found: ${plaidItemId}`);

  // Decrypt token only for this call — never stored decrypted
  const access_token = decrypt(item.accessToken);
  let   cursor       = item.cursor ?? null;

  let added:    any[] = [];
  let modified: any[] = [];
  let removed:  any[] = [];
  let hasMore  = true;

  // Loop through pages — Plaid paginates sync results
  while (hasMore) {
    const response = await plaidClient.transactionsSync({
      access_token,
      cursor: cursor ?? undefined,
      count: 500,  // max per page
    });

    const data = response.data;
    added    = added.concat(data.added);
    modified = modified.concat(data.modified);
    removed  = removed.concat(data.removed);
    hasMore  = data.has_more;
    cursor   = data.next_cursor; // advance cursor for next page
  }

  // ── Persist ADDED transactions ──────────────────────────────────
  for (const txn of added) {
    const account = await prisma.account.findUnique({
      where: { plaidAccountId: txn.account_id },
    });
    if (!account) continue;

    await prisma.transaction.upsert({
      where:  { plaidTransactionId: txn.transaction_id },
      update: {
        pending:          txn.pending,
        amount:           txn.amount,
        merchantName:     txn.merchant_name                       ?? null,
        categoryPrimary:  txn.personal_finance_category?.primary  ?? null,
        categoryDetailed: txn.personal_finance_category?.detailed ?? null,
        // rawJson intentionally NOT updated — immutable after first insert
      },
      create: {
        userId:             item.userId,
        accountId:          account.id,
        plaidTransactionId: txn.transaction_id,
        amount:             txn.amount,
        isoCurrencyCode:    txn.iso_currency_code                 ?? null,
        date:               new Date(txn.date),
        name:               txn.name,
        merchantName:       txn.merchant_name                     ?? null,
        categoryPrimary:    txn.personal_finance_category?.primary  ?? null,
        categoryDetailed:   txn.personal_finance_category?.detailed ?? null,
        pending:            txn.pending,
        rawJson:            txn, // immutable — never update this column
      },
    });
  }

  // ── Update MODIFIED transactions ────────────────────────────────
  // Pending → posted transitions, amount corrections, category updates
  for (const txn of modified) {
    await prisma.transaction.updateMany({
      where: { plaidTransactionId: txn.transaction_id },
      data: {
        pending:          txn.pending,
        amount:           txn.amount,
        merchantName:     txn.merchant_name                       ?? null,
        categoryPrimary:  txn.personal_finance_category?.primary  ?? null,
        categoryDetailed: txn.personal_finance_category?.detailed ?? null,
      },
    });
  }

  // ── Soft-delete REMOVED transactions ───────────────────────────
  // Never hard-delete — set deletedAt timestamp instead.
  // Raw data stays in DB as audit trail + future ML training data.
  for (const removedTxn of removed) {
    await prisma.transaction.updateMany({
      where: { plaidTransactionId: removedTxn.transaction_id },
      data:  { deletedAt: new Date() },
    });
  }

  // ── Save cursor + lastSyncedAt back to DB ───────────────────────
  await prisma.plaidItem.update({
    where: { id: plaidItemId },
    data:  { cursor, lastSyncedAt: new Date() },
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

return {
  added:    added.length,
  modified: modified.length,
  removed:  removed.length,
};
}

export { syncTransactions };
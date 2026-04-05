// ─────────────────────────────────────────────────────────────────
//  services/plaidSync.js
//  Reusable sync function — called by both the /transactions route
//  and the /webhook handler. Uses /transactions/sync (cursor-based
//  delta fetching) instead of re-fetching everything every time.
// ─────────────────────────────────────────────────────────────────

const prisma      = require("../lib/prisma");
const { decrypt } = require("../utils/encrypt");

async function syncTransactions(plaidClient, plaidItemId) {
  // Load PlaidItem from DB to get the cursor + encrypted token
  const item = await prisma.plaidItem.findUnique({
    where: { id: plaidItemId },
  });

  if (!item) throw new Error(`PlaidItem not found: ${plaidItemId}`);

  // Decrypt token only for this call — never stored decrypted
  const access_token = decrypt(item.accessToken);
  let   cursor       = item.cursor ?? null;

  let added    = [];
  let modified = [];
  let removed  = [];
  let hasMore  = true;

  // Loop through pages — Plaid paginates sync results
  while (hasMore) {
    const response = await plaidClient.transactionsSync({
      access_token,
      cursor,      // null on first call = fetch everything from the start
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

  return {
    added:    added.length,
    modified: modified.length,
    removed:  removed.length,
  };
}

module.exports = { syncTransactions };
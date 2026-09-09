import { PlaidApi } from 'plaid'
import * as Sentry from '@sentry/node'
import prisma from '../lib/prisma'
import { decrypt } from '../utils/encrypt'

export interface PlaidItemSummary {
  id:              string
  institutionName: string | null
  institutionId:   string | null
  status:          string
  errorCode:       string | null
  lastSyncedAt:    Date | null
  accountCount:    number
}

// Allow-listed via `select` (never a full-row spread) so accessToken/cursor can
// never leak here even if the model grows more sensitive fields later.
export async function listPlaidItems(userId: string): Promise<PlaidItemSummary[]> {
  const items = await prisma.plaidItem.findMany({
    where:   { userId },
    orderBy: { createdAt: 'asc' },
    select: {
      id:              true,
      institutionName: true,
      institutionId:   true,
      status:          true,
      errorCode:       true,
      lastSyncedAt:    true,
      _count: { select: { accounts: true } },
    },
  })

  return items.map((item) => ({
    id:              item.id,
    institutionName: item.institutionName,
    institutionId:   item.institutionId,
    status:          item.status,
    errorCode:       item.errorCode,
    lastSyncedAt:    item.lastSyncedAt,
    accountCount:    item._count.accounts,
  }))
}

// Plaid keeps billing for a live Item every month until /item/remove succeeds,
// so deleting local rows without calling it is a financial bug, not a tidiness
// one. Every code path that drops a PlaidItem must go through this function.
//
// Codes treated as "already gone": there is no live Item left to bill under this
// token, so local cleanup should proceed. Anything else rethrows, which aborts
// the caller and leaves local rows intact — the user retries rather than
// silently orphaning a billable Item.
const ALREADY_REMOVED_CODES = new Set(['ITEM_NOT_FOUND', 'INVALID_ACCESS_TOKEN'])

export async function removeItemAtPlaid(
  plaidClient:          PlaidApi,
  encryptedAccessToken: string,
): Promise<void> {
  const accessToken = decrypt(encryptedAccessToken)

  try {
    await plaidClient.itemRemove({ access_token: accessToken })
  } catch (err: any) {
    const code = err?.response?.data?.error_code
    if (!ALREADY_REMOVED_CODES.has(code)) throw err

    // Not fatal, but worth seeing: if this fires often it means tokens are
    // going stale before users disconnect, and Items may be billing unnoticed.
    Sentry.captureMessage('plaid.itemRemove skipped — item already gone', {
      level: 'warning',
      extra: { errorCode: code },
    })
  }
}

export async function unlinkPlaidItem(
  plaidClient: PlaidApi,
  userId:      string,
  itemId:      string,
): Promise<void> {
  const item = await prisma.plaidItem.findFirst({ where: { id: itemId, userId } })
  if (!item) throw new Error('PlaidItem not found')

  // Revoke at Plaid BEFORE touching local rows — a Plaid failure must never
  // leave orphaned local state (deleted here, still live at Plaid or vice versa).
  await removeItemAtPlaid(plaidClient, item.accessToken)

  const accounts = await prisma.account.findMany({
    where:  { plaidItemId: item.id },
    select: { id: true },
  })
  const accountIds = accounts.map((a) => a.id)

  await prisma.$transaction([
    prisma.transaction.deleteMany({ where: { accountId: { in: accountIds } } }),
    prisma.account.deleteMany({ where: { plaidItemId: item.id } }),
    prisma.plaidItem.delete({ where: { id: item.id } }),
  ])
}

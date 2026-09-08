import { PlaidApi } from 'plaid'
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

export async function unlinkPlaidItem(
  plaidClient: PlaidApi,
  userId:      string,
  itemId:      string,
): Promise<void> {
  const item = await prisma.plaidItem.findFirst({ where: { id: itemId, userId } })
  if (!item) throw new Error('PlaidItem not found')

  const accessToken = decrypt(item.accessToken)

  // Revoke at Plaid BEFORE touching local rows — a Plaid failure must never
  // leave orphaned local state (deleted here, still live at Plaid or vice versa).
  try {
    await plaidClient.itemRemove({ access_token: accessToken })
  } catch (err: any) {
    const code = err?.response?.data?.error_code
    if (code !== 'ITEM_NOT_FOUND') throw err
    // Already gone at Plaid — treat as success and continue with local cleanup.
  }

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

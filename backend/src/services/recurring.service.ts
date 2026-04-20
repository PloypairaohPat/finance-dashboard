import { PlaidApi } from 'plaid'
import prisma        from '../lib/prisma'
import { decrypt }   from '../utils/encrypt'

export async function fetchRecurring(plaidClient: PlaidApi, userId: string) {
  const items = await prisma.plaidItem.findMany({
    where:   { userId },
    include: { accounts: true },
  })

  if (items.length === 0) {
    return { outflow: [], inflow: [], monthlyOutflow: 0 }
  }

  let allOutflow: any[] = []
  let allInflow:  any[] = []

  for (const item of items) {
    const access_token = decrypt(item.accessToken)
    const account_ids  = item.accounts.map((a: { plaidAccountId: string }) => a.plaidAccountId)

    if (account_ids.length === 0) continue

    const response = await plaidClient.transactionsRecurringGet({
      access_token,
      account_ids,
    })

    const { outflow_streams, inflow_streams } = response.data

    const outflow = outflow_streams
      .filter((s) => s.status === 'MATURE' || s.status === 'EARLY_DETECTION')
      .map((s) => ({
        merchantName:  s.merchant_name || s.description,
        frequency:     s.frequency,
        lastAmount:    Math.abs(Number(s.last_amount?.amount    ?? 0)),
        averageAmount: Math.abs(Number(s.average_amount?.amount ?? 0)),
        lastDate:      s.last_date,
        status:        s.status,
        category:      s.personal_finance_category?.primary ?? null,
      }))
      .sort((a, b) => b.averageAmount - a.averageAmount)

    const inflow = inflow_streams
      .filter((s) => s.status === 'MATURE' || s.status === 'EARLY_DETECTION')
      .map((s) => ({
        merchantName:  s.merchant_name || s.description,
        frequency:     s.frequency,
        lastAmount:    Math.abs(Number(s.last_amount?.amount    ?? 0)),
        averageAmount: Math.abs(Number(s.average_amount?.amount ?? 0)),
        lastDate:      s.last_date,
        status:        s.status,
        category:      s.personal_finance_category?.primary ?? null,
      }))
      .sort((a, b) => b.averageAmount - a.averageAmount)

    allOutflow = allOutflow.concat(outflow)
    allInflow  = allInflow.concat(inflow)
  }

  const monthlyOutflow = allOutflow.reduce((sum, s) => {
    const monthly =
      s.frequency === 'WEEKLY'       ? s.averageAmount * 4.33 :
      s.frequency === 'BIWEEKLY'     ? s.averageAmount * 2.17 :
      s.frequency === 'SEMI_MONTHLY' ? s.averageAmount * 2    :
      s.frequency === 'ANNUALLY'     ? s.averageAmount / 12   :
      s.averageAmount
    return sum + monthly
  }, 0)

  return {
    outflow:        allOutflow,
    inflow:         allInflow,
    monthlyOutflow: Math.round(monthlyOutflow * 100) / 100,
  }
}

import { PlaidApi } from 'plaid'
import prisma        from '../lib/prisma'
import { decrypt }   from '../utils/encrypt'
import { DEMO_USER_ID } from '../middleware/auth'

export async function fetchRecurring(plaidClient: PlaidApi, userId: string) {
  // Demo user has no real Plaid item — return curated recurring streams that
  // mirror the seeded subscriptions/bills, so the demo looks populated instead
  // of calling Plaid with the placeholder token (which would 500).
  if (userId === DEMO_USER_ID) {
    return demoRecurring()
  }

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

// ── Demo data ──────────────────────────────────────────────────────
// Mirrors the recurring bills/subscriptions seeded in prisma/seed-demo.ts.
function isoRecent(dayOfMonth: number): string {
  const now = new Date()
  let y = now.getFullYear()
  let m = now.getMonth()
  if (dayOfMonth > now.getDate()) {
    m -= 1
    if (m < 0) { m = 11; y -= 1 }
  }
  return new Date(y, m, dayOfMonth).toISOString().slice(0, 10)
}

function demoRecurring() {
  const outflow = [
    { merchantName: 'Greystone Apartments', frequency: 'MONTHLY', lastAmount: 1650,  averageAmount: 1650,  lastDate: isoRecent(1),  status: 'MATURE', category: 'RENT_AND_UTILITIES' },
    { merchantName: 'Geico',                frequency: 'MONTHLY', lastAmount: 142.5, averageAmount: 142.5, lastDate: isoRecent(20), status: 'MATURE', category: 'RENT_AND_UTILITIES' },
    { merchantName: 'City Power & Light',   frequency: 'MONTHLY', lastAmount: 108,   averageAmount: 108,   lastDate: isoRecent(8),  status: 'MATURE', category: 'RENT_AND_UTILITIES' },
    { merchantName: 'Xfinity',              frequency: 'MONTHLY', lastAmount: 69.99, averageAmount: 69.99, lastDate: isoRecent(10), status: 'MATURE', category: 'RENT_AND_UTILITIES' },
    { merchantName: 'T-Mobile',             frequency: 'MONTHLY', lastAmount: 55,    averageAmount: 55,    lastDate: isoRecent(12), status: 'MATURE', category: 'RENT_AND_UTILITIES' },
    { merchantName: 'CrossFit Downtown',    frequency: 'MONTHLY', lastAmount: 39,    averageAmount: 39,    lastDate: isoRecent(6),  status: 'MATURE', category: 'ENTERTAINMENT' },
    { merchantName: 'Netflix',              frequency: 'MONTHLY', lastAmount: 15.49, averageAmount: 15.49, lastDate: isoRecent(3),  status: 'MATURE', category: 'ENTERTAINMENT' },
    { merchantName: 'Spotify',              frequency: 'MONTHLY', lastAmount: 11.99, averageAmount: 11.99, lastDate: isoRecent(5),  status: 'MATURE', category: 'ENTERTAINMENT' },
    { merchantName: 'Apple iCloud',         frequency: 'MONTHLY', lastAmount: 2.99,  averageAmount: 2.99,  lastDate: isoRecent(2),  status: 'MATURE', category: 'ENTERTAINMENT' },
  ]
  const inflow = [
    { merchantName: 'Employer Payroll', frequency: 'SEMI_MONTHLY', lastAmount: 2450, averageAmount: 2450, lastDate: isoRecent(15), status: 'MATURE', category: 'INCOME' },
  ]
  const monthlyOutflow =
    Math.round(outflow.reduce((sum, s) => sum + s.averageAmount, 0) * 100) / 100
  return { outflow, inflow, monthlyOutflow }
}

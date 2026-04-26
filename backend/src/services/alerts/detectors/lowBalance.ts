import type { Detector } from "../types"

const LOW_THRESHOLD = 100
const CRITICAL_THRESHOLD = 25

export const detectLowBalance: Detector = (ctx) => {
  const { accounts, now } = ctx
  const dateStr = now.toISOString().slice(0, 10)
  const out = []

  for (const account of accounts) {
    if (account.type !== "depository") continue
    const balance = Number(account.currentBalance ?? account.availableBalance ?? 0)
    if (balance >= LOW_THRESHOLD) continue

    const severity = balance < CRITICAL_THRESHOLD ? "high" as const : "medium" as const
    out.push({
      kind: "low_balance" as const,
      fingerprint: `low_balance:${account.id}:${dateStr}`,
      severity,
      title: `${account.name} balance is low`,
      body: `Your ${account.name} account has only $${balance.toFixed(2)} remaining.`,
      data: { accountId: account.id, accountName: account.name, balance },
    })
  }

  return out
}
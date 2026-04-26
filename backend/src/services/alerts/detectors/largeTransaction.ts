import type { Detector } from "../types"

const ABSOLUTE_THRESHOLD = 500
const MERCHANT_MULTIPLIER = 3
const MIN_MERCHANT_HISTORY = 3

export const detectLargeTransaction: Detector = (ctx) => {
  const { transactions, now } = ctx
  const lookback = new Date(now); lookback.setDate(lookback.getDate() - 14)

  const byMerchant = new Map<string, number[]>()
  for (const tx of transactions) {
    const amt = Number(tx.amount)
    if (amt <= 0) continue
    const key = (tx.cleanName ?? tx.name ?? "").toLowerCase()
    if (!key) continue
    const arr = byMerchant.get(key) ?? []
    arr.push(amt)
    byMerchant.set(key, arr)
  }

  const median = (arr: number[]) => {
    const s = [...arr].sort((a, b) => a - b)
    const mid = Math.floor(s.length / 2)
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
  }

  const out = []
  for (const tx of transactions) {
    const amt = Number(tx.amount)
    if (tx.date < lookback) continue
    if (amt <= 0) continue

    const merchant = (tx.cleanName ?? tx.name ?? "").toLowerCase()
    const history = byMerchant.get(merchant) ?? []
    const isAbsoluteLarge = amt >= ABSOLUTE_THRESHOLD
    const merchantMedian = history.length >= MIN_MERCHANT_HISTORY ? median(history) : null
    const isMerchantAnomaly = merchantMedian !== null && amt >= merchantMedian * MERCHANT_MULTIPLIER
    if (!isAbsoluteLarge && !isMerchantAnomaly) continue

    const dateStr = tx.date.toISOString().slice(0, 10)
    const merchantDisplay = tx.cleanName ?? tx.name ?? "Unknown"
    out.push({
      kind: "large_transaction" as const,
      fingerprint: `large_tx:${tx.id}`,
      severity: "medium" as const,
      title: `$${amt.toFixed(0)} at ${merchantDisplay} on ${dateStr}`,
      body: isMerchantAnomaly && merchantMedian
        ? `${(amt / merchantMedian).toFixed(1)}× your typical spend there (~$${merchantMedian.toFixed(0)}). Worth a look?`
        : `Larger than your usual transactions. Worth a look?`,
      data: { transactionId: tx.id, amount: amt, merchant: merchantDisplay },
    })
  }
  return out
}
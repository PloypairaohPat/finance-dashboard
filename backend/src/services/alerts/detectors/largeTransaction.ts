import type { Detector } from "../types"
import type { ClassifiedRow } from "../../classification.service"

const ABSOLUTE_THRESHOLD = 500
const MERCHANT_MULTIPLIER = 3
const MIN_MERCHANT_HISTORY = 3

// M7.3: only rows the classifier calls spending are candidates. This detector had
// no category test at all, so paying off a credit card or moving money to savings
// fired "Large purchase detected" — the alert most likely to make someone
// distrust the app, on a transaction where nothing was purchased.
const isSpend = (row: ClassifiedRow) => row.verdict.kind === "spend"

export const detectLargeTransaction: Detector = (ctx) => {
  const { classified, now } = ctx
  const lookback = new Date(now); lookback.setUTCDate(now.getUTCDate() - 14)

  const spending = classified.filter(isSpend)

  // Merchant history is built from spending too, so a card payment can't inflate
  // a merchant's median and mask a genuinely large purchase there.
  const byMerchant = new Map<string, number[]>()
  for (const row of spending) {
    const key = row.merchantLabel.toLowerCase()
    if (!key) continue
    const arr = byMerchant.get(key) ?? []
    arr.push(row.amount)
    byMerchant.set(key, arr)
  }

  const median = (arr: number[]) => {
    const s = [...arr].sort((a, b) => a - b)
    const mid = Math.floor(s.length / 2)
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
  }

  const out = []
  for (const row of spending) {
    if (row.date < lookback) continue
    const amt = row.amount

    const merchant = row.merchantLabel.toLowerCase()
    const history = byMerchant.get(merchant) ?? []
    const isAbsoluteLarge = amt >= ABSOLUTE_THRESHOLD
    const merchantMedian = history.length >= MIN_MERCHANT_HISTORY ? median(history) : null
    const isMerchantAnomaly = merchantMedian !== null && amt >= merchantMedian * MERCHANT_MULTIPLIER
    if (!isAbsoluteLarge && !isMerchantAnomaly) continue

    const dateStr = row.date.toISOString().slice(0, 10)
    const merchantDisplay = row.merchantLabel
    out.push({
      kind: "large_transaction" as const,
      fingerprint: `large_tx:${row.id}`,
      severity: "medium" as const,
      title: `$${amt.toFixed(0)} at ${merchantDisplay} on ${dateStr}`,
      body: isMerchantAnomaly && merchantMedian
        ? `${(amt / merchantMedian).toFixed(1)}× your typical spend there (~$${merchantMedian.toFixed(0)}). Worth a look?`
        : `Larger than your usual transactions. Worth a look?`,
      data: { transactionId: row.id, amount: amt, merchant: merchantDisplay },
    })
  }
  return out
}

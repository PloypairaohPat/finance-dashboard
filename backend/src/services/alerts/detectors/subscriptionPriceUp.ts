import type { DetectedAlert, Detector } from "../types"

/**
 * How long a price rise stays news, in days after the raised charge.
 *
 * subscription_price_up is an EVENT alert: it can never become untrue, so it
 * ages out. This one constant decides both halves — the detector emits the
 * alert only while the raised charge is within it, and once it isn't, the
 * alert resolves by absence (runDetectors). Detection and resolution share it
 * so the two can never disagree about how long the event lasts.
 */
export const PRICE_UP_LOOKBACK_DAYS = 30

const DAY_MS = 86_400_000

/**
 * A subscription that charged more than last time.
 *
 * Reads stored data only (ctx.subscriptions — no Plaid call when the bell
 * opens). Subscriptions, not bills: bills vary by nature. The size of a change
 * is decided where priceChange is computed (subscriptions.service: at least 5%
 * either way); this fires on the rises.
 *
 * Until M7.3 it read `priceChange` as a number and two fields that don't exist,
 * through an `any` cast, and never fired. The input is typed now.
 */
export const detectSubscriptionPriceUp: Detector = (ctx) => {
  // An unreadable input answers for nothing: throwing leaves this detector's
  // alerts exactly as they are, instead of resolving them by absence.
  if (!ctx.subscriptions.ok) throw ctx.subscriptions.error

  // Whole UTC days, so the lookback can't depend on the machine's time zone.
  const today = Math.floor(ctx.now.getTime() / DAY_MS)
  const out: DetectedAlert[] = []

  for (const s of ctx.subscriptions.analysis.subscriptions) {
    // A marked subscription that has ended isn't news, whatever it last cost.
    if (s.status === "ended") continue
    // Wait for the raised charge to post: a pending amount can still change,
    // and the posted row's date (part of the fingerprint) usually differs, so
    // the same rise would fire twice.
    if (s.lastChargePending) continue
    const change = s.priceChange
    if (!change || change.pctChange <= 0) continue

    // lastDate is the raised charge, as a UTC date (YYYY-MM-DD).
    const chargedOn = Math.floor(Date.parse(`${s.lastDate}T00:00:00.000Z`) / DAY_MS)
    if (today - chargedOn > PRICE_UP_LOOKBACK_DAYS) continue

    out.push({
      kind: "subscription_price_up",
      // The grouping key (merchantIdentity), not the display name: the name can
      // change when a new variant of the merchant's name arrives, which would
      // fire the same rise twice. One alert per stream per raised charge. A
      // marked subscription feeds this exactly as a detected one does.
      fingerprint: `price_up:${s.key}:${s.lastDate}`,
      severity: change.pctChange > 25 ? "high" : "medium",
      title: `${s.merchant} raised its price`,
      body: `Charged $${s.lastAmount.toFixed(2)} — up from $${change.previousAmount.toFixed(2)} last time (+${change.pctChange.toFixed(0)}%).`,
      data: {
        merchant: s.merchant,
        key: s.key,
        lastAmount: s.lastAmount,
        previousAmount: change.previousAmount,
        pctChange: change.pctChange,
        chargedOn: s.lastDate,
      },
    })
  }

  return out
}

import prisma from "../../lib/prisma"
import type { AlertKind, Detector, DetectorContext, DetectedAlert } from "./types"
import { fetchSubscriptionAnalysis } from "../subscriptions.service"
import { classifyWindow } from "../classification.service"
import { getPeriodStartDay } from "../user.service"
import { fromDateKey, recentPeriods } from "../../lib/period"
import { plaidClient } from "../../lib/plaidClient"
import { Prisma } from "@prisma/client"

import { detectOverspending } from "./detectors/overspending"
import { detectLowBalance } from "./detectors/lowBalance"
import { detectMissedPaycheck } from "./detectors/missedPaycheck"
import { detectLargeTransaction } from "./detectors/largeTransaction"
import { detectSubscriptionPriceUp } from "./detectors/subscriptionPriceUp"
import { detectBudgetExceeded, detectBudgetProjectedOver } from "./detectors/budgetStatus"
import { detectPositiveMilestones } from "./detectors/positiveMilestones"

// Each detector owns the alert kinds it emits. Resolution works by absence — an
// alert its owner no longer emits is no longer true — so ownership has to be
// declared rather than inferred.
interface Registration {
  detector: Detector
  kinds: AlertKind[]
}

const DETECTORS: Registration[] = [
  { detector: detectOverspending, kinds: ["overspending"] },
  { detector: detectLowBalance, kinds: ["low_balance"] },
  { detector: detectMissedPaycheck, kinds: ["missed_paycheck"] },
  { detector: detectLargeTransaction, kinds: ["large_transaction"] },
  { detector: detectSubscriptionPriceUp, kinds: ["subscription_price_up"] },
  { detector: detectBudgetExceeded, kinds: ["budget_exceeded"] },
  { detector: detectBudgetProjectedOver, kinds: ["budget_projected_over"] },
  { detector: detectPositiveMilestones, kinds: ["positive_milestone"] },
]

/** How many money periods of history the detectors need: current + 3 prior, plus one spare. */
const CONTEXT_PERIODS = 5

export async function loadContext(userId: string): Promise<DetectorContext> {
  const now = new Date()
  const startDay = await getPeriodStartDay(userId)

  // Whole periods, not "120 days ago". Detectors compare a period against prior
  // periods, and the payment-app cap is a whole-period figure that classifyWindow
  // refuses to report for a period it only partly covers.
  const periods = recentPeriods(now, startDay, CONTEXT_PERIODS)

  const [accounts, classification, budgets, subsAnalysis, active] = await Promise.all([
    prisma.account.findMany({
      where: { userId },
    }),
    classifyWindow(userId, {
      since: fromDateKey(periods[0].start),
      until: fromDateKey(periods[periods.length - 1].end),
      startDay,
    }),
    prisma.budget.findMany({ where: { userId } }),
    fetchSubscriptionAnalysis(userId, plaidClient).catch(() => null),
    // Alerts still standing. A detector needs these for hysteresis: whether a
    // condition counts as "still true" can depend on whether it is already
    // firing. Dismissed-but-unresolved alerts count as firing — the user hid
    // the alert, they did not fix the thing.
    prisma.alert.findMany({ where: { userId, deletedAt: null, resolvedAt: null } }),
  ])

  return {
    userId,
    now,
    startDay,
    accounts,
    periods,
    classified: classification.rows,
    paymentAppByPeriod: classification.paymentAppByPeriod,
    budgets,
    subscriptionAnalysis: subsAnalysis,
    activeAlerts: new Map(active.map((a) => [a.fingerprint, a])),
  }
}

export async function runDetectors(userId: string): Promise<void> {
  const ctx = await loadContext(userId)
  const results: DetectedAlert[] = []
  // Only a detector that actually ran can speak for its kinds. If one throws,
  // its alerts are left exactly as they were: resolving by absence after a
  // failure would clear every alert the broken detector owns and call it good news.
  const answeredFor = new Set<AlertKind>()

  for (const { detector, kinds } of DETECTORS) {
    try {
      const out = await detector(ctx)
      results.push(...out)
      for (const kind of kinds) answeredFor.add(kind)
    } catch (err: any) {
      console.error(`Detector ${detector.name} failed:`, err.message)
    }
  }

  const emitted = results.map((r) => r.fingerprint)
  const existing = await prisma.alert.findMany({
    where: { userId, fingerprint: { in: emitted } },
  })
  const byFingerprint = new Map(existing.map((a) => [a.fingerprint, a]))
  const now = new Date()

  await Promise.all(results.map(alert => {
    const prior = byFingerprint.get(alert.fingerprint)
    // A resolved alert that fires again is a NEW occurrence, not a continuation:
    // clear the resolution, clear any old dismissal, and re-date it. Leaving the
    // dismissal in place would silence a condition the user fixed and then hit
    // again — silence by accident rather than by choice.
    const reTriggered = prior?.resolvedAt != null

    return prisma.alert.upsert({
      where: {
        userId_fingerprint: { userId, fingerprint: alert.fingerprint },
      },
      create: {
        userId,
        kind: alert.kind,
        fingerprint: alert.fingerprint,
        severity: alert.severity,
        title: alert.title,
        body: alert.body,
        data: (alert.data ?? {}) as Prisma.InputJsonValue,
      },
      update: {
        kind: alert.kind,
        severity: alert.severity,
        title: alert.title,
        body: alert.body,
        data: (alert.data ?? {}) as Prisma.InputJsonValue,
        // While an occurrence continues, dismissedAt is deliberately NOT reset:
        // this runs on every GET /alerts, and resetting it undid every dismissal
        // whose condition still held (M7.1). See tests/alerts-dismissal.test.ts.
        ...(reTriggered ? { resolvedAt: null, dismissedAt: null, triggeredAt: now } : {}),
        updatedAt: now,
      },
    })
  }))

  // Resolution by absence: anything an answering detector did not emit this run
  // is no longer true. For event-shaped alerts this also supplies the lifetime —
  // large_transaction stops being emitted when its transaction leaves the
  // detector's own lookback window, so detection and resolution share one
  // constant by construction rather than by a second number kept in step.
  if (answeredFor.size > 0) {
    await prisma.alert.updateMany({
      where: {
        userId,
        deletedAt: null,
        resolvedAt: null,
        kind: { in: [...answeredFor] },
        ...(emitted.length > 0 ? { fingerprint: { notIn: emitted } } : {}),
      },
      data: { resolvedAt: now },
    })
  }
}

export async function fetchActiveAlerts(userId: string) {
  return prisma.alert.findMany({
    // resolvedAt: an alert whose condition stopped being true leaves the bell
    // without the user having to dismiss it (M7.3).
    where: { userId, deletedAt: null, dismissedAt: null, resolvedAt: null },
    orderBy: [
      { severity: "asc" },
      { triggeredAt: "desc" },
    ],
  })
}

export async function fetchAllAlerts(userId: string) {
  return prisma.alert.findMany({
    where: { userId, deletedAt: null },
    orderBy: { triggeredAt: "desc" },
    take: 100,
  })
}

export async function dismissAlert(userId: string, alertId: string) {
  const alert = await prisma.alert.findFirst({
    where: { id: alertId, userId, deletedAt: null },
  })
  if (!alert) throw new Error("Alert not found")
  return prisma.alert.update({
    where: { id: alertId },
    data: { dismissedAt: new Date() },
  })
}
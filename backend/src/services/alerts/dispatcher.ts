import prisma from "../../lib/prisma"
import type { Detector, DetectorContext, DetectedAlert } from "./types"
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

const DETECTORS: Detector[] = [
  detectOverspending,
  detectLowBalance,
  detectMissedPaycheck,
  detectLargeTransaction,
  detectSubscriptionPriceUp,
  detectBudgetExceeded,
  detectBudgetProjectedOver,
  detectPositiveMilestones,
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

  const [accounts, classification, budgets, subsAnalysis] = await Promise.all([
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
  }
}

export async function runDetectors(userId: string): Promise<void> {
  const ctx = await loadContext(userId)
  const results: DetectedAlert[] = []

  for (const detector of DETECTORS) {
    try {
      const out = await detector(ctx)
      results.push(...out)
    } catch (err: any) {
      console.error(`Detector ${detector.name} failed:`, err.message)
    }
  }

  await Promise.all(results.map(alert =>
    prisma.alert.upsert({
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
        // dismissedAt deliberately NOT reset: this runs on every GET /alerts,
        // so resetting it undid every dismissal whose condition still held.
        // A dismissal now lasts for the fingerprint's period (a day for
        // low_balance, a month for most detectors). See
        // tests/alerts-dismissal.test.ts and docs/m7.3-data-trust-notes.md.
        updatedAt: new Date(),
      },
    })
  ))
}

export async function fetchActiveAlerts(userId: string) {
  return prisma.alert.findMany({
    where: { userId, deletedAt: null, dismissedAt: null },
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
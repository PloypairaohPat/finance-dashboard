import prisma from "../../lib/prisma"
import type { Detector, DetectorContext, DetectedAlert } from "./types"
import { fetchSubscriptionAnalysis } from "../subscriptions.service"
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

async function loadContext(userId: string): Promise<DetectorContext> {
  const now = new Date()
  const since = new Date(now); since.setDate(since.getDate() - 120)

  const [accounts, transactions, budgets, subsAnalysis] = await Promise.all([
    prisma.account.findMany({
      where: { userId },
    }),
    prisma.transaction.findMany({
      where: { userId, deletedAt: null, date: { gte: since } },
      orderBy: { date: "desc" },
    }),
    prisma.budget.findMany({
      where: {
        userId,
        month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
      },
    }),
    fetchSubscriptionAnalysis(userId, plaidClient).catch(() => null),
  ])

  return { userId, now, accounts, transactions, budgets, subscriptionAnalysis: subsAnalysis }
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
        dismissedAt: null,
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
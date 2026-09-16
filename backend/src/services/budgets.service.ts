import prisma from "../lib/prisma"
import {
  mapPlaidCategory,
  DISPLAY_CATEGORIES,
} from "../lib/categoryMap"
import { PAYMENTS_TO_PEOPLE } from "../lib/classifier"
import {
  DEFAULT_PERIOD_START_DAY,
  describePeriod,
  fromDateKey,
  periodStartFor,
  recentPeriods,
  type Period,
} from "../lib/period"
import { classifyWindow, spendByBucketForRows } from "./classification.service"

export type BudgetStatus =
  | "on_track"
  | "warning"
  | "over"
  | "projected_over"

export interface BudgetWithSpend {
  id: string
  category: string
  monthlyLimit: number
  currentSpend: number
  percentUsed: number
  remaining: number
  projected: number | null
  status: BudgetStatus
  month: string
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7)
}

export async function upsertBudget(
  userId: string,
  category: string,
  monthlyLimit: number
): Promise<void> {
  if (!(DISPLAY_CATEGORIES as readonly string[]).includes(category)) {
    throw new Error("Invalid category")
  }

  await prisma.budget.upsert({
    where: {
      userId_category: { userId, category },
    },
    update: { monthlyLimit },
    create: { userId, category, monthlyLimit },
  })
}

export async function deleteBudget(
  userId: string,
  budgetId: string
): Promise<void> {
  await prisma.budget.deleteMany({
    where: { id: budgetId, userId },
  })
}

/**
 * Which window a budget covers. Accepts a period key (YYYY-MM-DD), the historical
 * month form (YYYY-MM), or nothing for the user's current period.
 */
function resolvePeriod(arg: string | undefined, startDay: number, now: Date): Period {
  if (!arg) return recentPeriods(now, startDay, 1)[0]
  const anchor = arg.length === 7
    ? new Date(`${arg}-01T00:00:00.000Z`)
    : new Date(`${arg}T00:00:00.000Z`)
  return describePeriod(periodStartFor(anchor, startDay), startDay, now)
}

export async function fetchBudgetsWithSpend(
  userId: string,
  monthOrPeriod?: string,
  startDay: number = DEFAULT_PERIOD_START_DAY,
  now: Date = new Date(),
): Promise<BudgetWithSpend[]> {
  const budgets = await prisma.budget.findMany({
    where: { userId },
  })

  if (budgets.length === 0) return []

  const shape = (
    spendMap: Record<string, number>,
    windowLabel: string,
    elapsed: number,
    length: number,
    projectionAllowed: boolean,
  ): BudgetWithSpend[] =>
    budgets.map((b) => {
      const limit = b.monthlyLimit.toNumber()
      const spend = Math.round((spendMap[b.category] ?? 0) * 100) / 100
      const pct = limit > 0 ? Math.round((spend / limit) * 1000) / 10 : 0
      const remaining = Math.round((limit - spend) * 100) / 100
      const projected =
        projectionAllowed && elapsed > 0
          ? Math.round(((spend / elapsed) * length) * 100) / 100
          : null

      let status: BudgetStatus
      if (pct >= 100) status = "over"
      else if (projected !== null && projected > limit) status = "projected_over"
      else if (pct >= 75) status = "warning"
      else status = "on_track"

      return {
        id: b.id,
        category: b.category,
        monthlyLimit: limit,
        currentSpend: spend,
        percentUsed: pct,
        remaining,
        projected,
        status,
        month: windowLabel,
      }
    })

  const period = resolvePeriod(monthOrPeriod, startDay, now)
  const { rows } = await classifyWindow(userId, {
    since: fromDateKey(period.start),
    until: fromDateKey(period.end),
    startDay,
  })
  const spendMap = spendByBucketForRows(rows, PAYMENTS_TO_PEOPLE)
  // Pace is measured against the period, so a budget on a period starting the
  // 10th is a tenth of the way through on the 10th, not two thirds of the way
  // through because the calendar month is.
  return shape(
    spendMap,
    period.key,
    period.dayOfPeriod,
    period.daysInPeriod,
    period.inProgress && period.dayOfPeriod >= 7,
  )
}

export async function fetchBudgetStatus(
  userId: string,
  month?: string,
  startDay: number = DEFAULT_PERIOD_START_DAY,
) {
  const budgets = await fetchBudgetsWithSpend(userId, month, startDay)

  return {
    // The period key the budgets actually covered.
    month: budgets[0]?.month ?? month ?? currentMonth(),
    total: budgets.length,
    on_track: budgets.filter((b) => b.status === "on_track").length,
    warning: budgets.filter((b) => b.status === "warning").length,
    over: budgets.filter((b) => b.status === "over").length,
    projected_over: budgets.filter((b) => b.status === "projected_over").length,
    budgets,
  }
}
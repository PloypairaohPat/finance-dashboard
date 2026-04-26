import prisma from "../lib/prisma"
import { isSpending } from "../lib/categoryMap"

export type GoalType = "savings" | "emergency_fund" | "vacation" | "debt_payoff"

const DEFAULT_EMERGENCY_MONTHS = 6

export interface GoalInput {
  type: GoalType
  name: string
  targetAmount?: number | null
  startAmount?: number | null
  deadline?: string | null        // YYYY-MM-DD
  accountId?: string | null
  data?: Record<string, unknown>
}

export interface EnrichedGoal {
  id: string
  type: GoalType
  name: string
  targetAmount: number | null
  startAmount: number | null
  currentAmount: number           // progress value
  progressPct: number             // 0-100, clamped
  deadline: string | null
  accountId: string | null
  data: Record<string, unknown>
  status: "on_track" | "behind" | "ahead" | "complete" | "new"
  hint: string | null             // human-readable pacing context
  createdAt: string
}

// — — — Progress computation per type — — —

async function computeEmergencyProgress(userId: string) {
  const ninetyAgo = new Date(); ninetyAgo.setDate(ninetyAgo.getDate() - 90)
  const [accounts, txs] = await Promise.all([
    prisma.account.findMany({ where: { userId, type: "depository" } }),
    prisma.transaction.findMany({
      where: { userId, deletedAt: null, amount: { gt: 0 }, date: { gte: ninetyAgo } },
      select: { amount: true, category: true, date: true },
    }),
  ])

  const current = accounts.reduce((s, a) => s + Number(a.currentBalance ?? 0), 0)

  const expenseTotal = txs
    .filter(t => isSpending(t.category))
    .reduce((s, t) => s + Number(t.amount), 0)
  const monthsOfData = new Set(txs.map(t =>
    `${t.date.getFullYear()}-${t.date.getMonth() + 1}`
  )).size
  const avgMonthlyExpenses = monthsOfData > 0 ? expenseTotal / monthsOfData : 0

  return { current, avgMonthlyExpenses }
}

async function computeAccountBalance(userId: string, accountId: string | null) {
  if (!accountId) return null
  const account = await prisma.account.findFirst({
    where: { id: accountId, userId },
  })
  return account ? Number(account.currentBalance ?? 0) : null
}

// — — — Enrichment — — —

function paceStatus(
  goal: { targetAmount: number | null; startAmount: number | null; deadline: Date | null; createdAt: Date; type: GoalType },
  current: number,
  target: number,
  now: Date,
): { status: EnrichedGoal["status"]; hint: string | null } {
  if (target > 0 && current >= target) return { status: "complete", hint: "Goal reached!" }

  if (goal.type === "debt_payoff" && goal.startAmount) {
    const paid = Number(goal.startAmount) - current
    const pct = Number(goal.startAmount) > 0 ? paid / Number(goal.startAmount) : 0
    if (goal.deadline) {
      const elapsed = (now.getTime() - goal.createdAt.getTime()) /
                      (goal.deadline.getTime() - goal.createdAt.getTime())
      if (pct >= elapsed + 0.05) return { status: "ahead", hint: "ahead of pace" }
      if (pct <= elapsed - 0.05) return { status: "behind", hint: "behind pace" }
    }
    return { status: "on_track", hint: null }
  }

  if (!goal.deadline) return { status: "on_track", hint: null }

  const totalDays = Math.max(1,
    (goal.deadline.getTime() - goal.createdAt.getTime()) / 86400000)
  const elapsedDays = Math.max(0,
    (now.getTime() - goal.createdAt.getTime()) / 86400000)
  const timePct = Math.min(1, elapsedDays / totalDays)
  const progressPct = target > 0 ? current / target : 0
  const daysLeft = Math.max(0, Math.round(
    (goal.deadline.getTime() - now.getTime()) / 86400000))

  if (progressPct >= timePct + 0.05) {
    return { status: "ahead", hint: `${daysLeft} days left — ahead of pace` }
  }
  if (progressPct <= timePct - 0.05) {
    return { status: "behind", hint: `${daysLeft} days left — behind pace` }
  }
  return { status: "on_track", hint: `${daysLeft} days left — on track` }
}

// — — — Main fetch — — —

export async function fetchGoalsWithProgress(userId: string): Promise<EnrichedGoal[]> {
  const now = new Date()
  const goals = await prisma.goal.findMany({
    where: { userId, deletedAt: null },
    orderBy: { createdAt: "desc" },
  })

  const hasEmergency = goals.some(g => g.type === "emergency_fund")
  const emergencyCtx = hasEmergency ? await computeEmergencyProgress(userId) : null

  const enriched: EnrichedGoal[] = []
  for (const g of goals) {
    const type = g.type as GoalType
    let current = 0
    let target = Number(g.targetAmount ?? 0)

    switch (type) {
      case "emergency_fund": {
        const months = Number((g.data as any)?.months ?? DEFAULT_EMERGENCY_MONTHS)
        current = emergencyCtx!.current
        target = Number((emergencyCtx!.avgMonthlyExpenses * months).toFixed(2))
        break
      }
      case "savings":
      case "vacation": {
        const linked = await computeAccountBalance(userId, g.accountId)
        current = linked !== null ? linked : Number((g.data as any)?.manualAmount ?? 0)
        break
      }
      case "debt_payoff": {
        const linked = await computeAccountBalance(userId, g.accountId)
        const currentDebt = Math.abs(linked ?? Number(g.startAmount ?? 0))
        const start = Number(g.startAmount ?? currentDebt)
        current = start - currentDebt
        target = start
        break
      }
    }

    const rawPct = target > 0 ? (current / target) * 100 : 0
    const progressPct = Math.min(100, Math.max(0, Number(rawPct.toFixed(1))))
    const { status, hint } = paceStatus(
      {
        targetAmount: g.targetAmount ? Number(g.targetAmount) : null,
        startAmount: g.startAmount ? Number(g.startAmount) : null,
        deadline: g.deadline,
        createdAt: g.createdAt,
        type,
      },
      current, target, now,
    )

    enriched.push({
      id: g.id,
      type,
      name: g.name,
      targetAmount: target,
      startAmount: g.startAmount ? Number(g.startAmount) : null,
      currentAmount: Number(current.toFixed(2)),
      progressPct,
      deadline: g.deadline ? g.deadline.toISOString().slice(0, 10) : null,
      accountId: g.accountId,
      data: (g.data as Record<string, unknown>) ?? {},
      status,
      hint,
      createdAt: g.createdAt.toISOString(),
    })
  }
  return enriched
}

// — — — CRUD — — —

export async function createGoal(userId: string, input: GoalInput) {
  const validTypes: GoalType[] = ["savings", "emergency_fund", "vacation", "debt_payoff"]
  if (!validTypes.includes(input.type)) throw new Error("Invalid goal type")
  if (!input.name?.trim()) throw new Error("Name required")

  if (input.type === "debt_payoff" && !input.accountId) {
    throw new Error("Debt payoff goals require an account link")
  }
  if (input.type === "vacation" && !input.deadline) {
    throw new Error("Vacation goals require a deadline")
  }
  if (input.type !== "emergency_fund" && (!input.targetAmount || input.targetAmount <= 0) && input.type !== "debt_payoff") {
    throw new Error("Target amount required")
  }

  let startAmount = input.startAmount
  if (input.type === "debt_payoff" && !startAmount && input.accountId) {
    const acc = await prisma.account.findFirst({
      where: { id: input.accountId, userId },
    })
    startAmount = Math.abs(Number(acc?.currentBalance ?? 0))
  }

  return prisma.goal.create({
    data: {
      userId,
      type: input.type,
      name: input.name.trim(),
      targetAmount: input.targetAmount ?? null,
      startAmount: startAmount ?? null,
      deadline: input.deadline ? new Date(input.deadline + "T00:00:00Z") : null,
      accountId: input.accountId ?? null,
      data: (input.data ?? {}) as any,
    },
  })
}

export async function updateGoal(userId: string, goalId: string, input: Partial<GoalInput>) {
  const existing = await prisma.goal.findFirst({
    where: { id: goalId, userId, deletedAt: null },
  })
  if (!existing) throw new Error("Goal not found")

  return prisma.goal.update({
    where: { id: goalId },
    data: {
      name: input.name?.trim() ?? existing.name,
      targetAmount: input.targetAmount ?? existing.targetAmount,
      deadline: input.deadline !== undefined
        ? (input.deadline ? new Date(input.deadline + "T00:00:00Z") : null)
        : existing.deadline,
      accountId: input.accountId ?? existing.accountId,
      data: input.data ?? (existing.data as any),
    },
  })
}

export async function deleteGoal(userId: string, goalId: string) {
  const existing = await prisma.goal.findFirst({
    where: { id: goalId, userId, deletedAt: null },
  })
  if (!existing) throw new Error("Goal not found")
  return prisma.goal.update({
    where: { id: goalId },
    data: { deletedAt: new Date() },
  })
}
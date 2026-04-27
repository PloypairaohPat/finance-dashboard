import { Request, Response } from "express"
import {
  upsertBudget,
  fetchBudgetsWithSpend,
  fetchBudgetStatus,
  deleteBudget,
} from "../services/budgets.service"
import { getUserId } from "../middleware/auth"
import { DISPLAY_CATEGORIES, CATEGORY_COLORS } from "../lib/categoryMap"

export async function createOrUpdateBudget(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const userId = getUserId(req)
    const { category, monthlyLimit, month } = req.body as {
      category:     string
      monthlyLimit: number
      month?:       string
    }
    if (!category || monthlyLimit == null) {
      res.status(400).json({ error: "category and monthlyLimit are required" })
      return
    }
    await upsertBudget(userId, category, monthlyLimit, month)
    res.json({ ok: true })
  } catch (err: any) {
    console.error("createOrUpdateBudget:", err.message)
    res.status(500).json({ error: "Failed to save budget" })
  }
}

export async function getBudgets(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const userId = getUserId(req)
    const month = req.query.month as string | undefined
    const budgets = await fetchBudgetsWithSpend(userId, month)
    res.json({ budgets })
  } catch (err: any) {
    console.error("getBudgets:", err.message)
    res.status(500).json({ error: "Failed to fetch budgets" })
  }
}

export async function getBudgetStatus(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const userId = getUserId(req)
    const month = req.query.month as string | undefined
    const status = await fetchBudgetStatus(userId, month)
    res.json(status)
  } catch (err: any) {
    console.error("getBudgetStatus:", err.message)
    res.status(500).json({ error: "Failed to fetch budget status" })
  }
}

export function getCategoryList(_req: Request, res: Response) {
  res.json(
    DISPLAY_CATEGORIES.map(category => ({
      category,
      color: CATEGORY_COLORS[category],
    }))
  )
}

export async function removeBudget(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const userId = getUserId(req)
    const id = req.params.id as string
    if (!id) {
      res.status(400).json({ error: "Budget id is required" })
      return
    }
    await deleteBudget(userId, id)
    res.json({ ok: true })
  } catch (err: any) {
    console.error("removeBudget:", err.message)
    res.status(500).json({ error: "Failed to delete budget" })
  }
}
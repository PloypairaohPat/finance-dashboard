import { Request, Response } from "express"
import {
  upsertBudget,
  fetchBudgetsWithSpend,
  fetchBudgetStatus,
} from "../services/budgets.service"

export async function createOrUpdateBudget(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { category, monthlyLimit, month } = req.body as {
      category:     string
      monthlyLimit: number
      month?:       string
    }
    if (!category || monthlyLimit == null) {
      res.status(400).json({ error: "category and monthlyLimit are required" })
      return
    }
    await upsertBudget(category, monthlyLimit, month)
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
    const month = req.query.month as string | undefined
    const budgets = await fetchBudgetsWithSpend(month)
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
    const month = req.query.month as string | undefined
    const status = await fetchBudgetStatus(month)
    res.json(status)
  } catch (err: any) {
    console.error("getBudgetStatus:", err.message)
    res.status(500).json({ error: "Failed to fetch budget status" })
  }
}
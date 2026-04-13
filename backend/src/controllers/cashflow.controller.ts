import { Request, Response } from "express"
import { fetchCashFlow } from "../services/cashflow.service"

const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID ?? "demo-user"

export async function getCashFlow(req: Request, res: Response): Promise<void> {
  try {
    const userId = (req.query.userId as string) || DEFAULT_USER_ID
    const months = req.query.months ? parseInt(req.query.months as string, 10) : 6

    const result = await fetchCashFlow(userId, months)
    res.json(result)
  } catch (err: any) {
    console.error("getCashFlow:", err.message)
    res.status(500).json({ error: "Failed to fetch cash flow" })
  }
}
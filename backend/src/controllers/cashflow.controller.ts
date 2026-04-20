import { Request, Response } from "express"
import { fetchCashFlow } from "../services/cashflow.service"
import { getUserId } from "../middleware/auth"

export async function getCashFlow(req: Request, res: Response): Promise<void> {
  try {
    const userId = getUserId(req)
    const months = req.query.months ? parseInt(req.query.months as string, 10) : 6

    const result = await fetchCashFlow(userId, months)
    res.json(result)
  } catch (err: any) {
    console.error("getCashFlow:", err.message)
    res.status(500).json({ error: "Failed to fetch cash flow" })
  }
}

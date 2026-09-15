import { Request, Response } from "express"
import { fetchCashFlow } from "../services/cashflow.service"
import { getPeriodStartDay } from "../services/user.service"
import { getUserId } from "../middleware/auth"

export async function getCashFlow(req: Request, res: Response): Promise<void> {
  try {
    const userId = getUserId(req)
    // `months` is the historical name; it is a count of periods (M7.2).
    const periods = req.query.months ? parseInt(req.query.months as string, 10) : 6
    const startDay = await getPeriodStartDay(userId)

    const result = await fetchCashFlow(userId, periods, startDay)
    res.json(result)
  } catch (err: any) {
    console.error("getCashFlow:", err.message)
    res.status(500).json({ error: "Failed to fetch cash flow" })
  }
}

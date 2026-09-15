import { Request, Response } from "express"
import { getUserId } from "../middleware/auth"
import { fetchInsights } from "../services/insights.service"
import { getPeriodStartDay } from "../services/user.service"

export async function getInsights(req: Request, res: Response) {
  try {
    const userId = getUserId(req)
    const startDay = await getPeriodStartDay(userId)
    const data = await fetchInsights(userId, startDay)
    res.json(data)
  } catch (err: any) {
    console.error("getInsights error:", err.message)
    res.status(500).json({ error: "Failed to fetch insights" })
  }
}

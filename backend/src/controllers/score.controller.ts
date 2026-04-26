import { Request, Response } from "express"
import { getUserId } from "../middleware/auth"
import { fetchFinancialScore } from "../services/score.service"

export async function getScore(req: Request, res: Response) {
  try {
    res.json(await fetchFinancialScore(getUserId(req)))
  } catch (err: any) {
    console.error("getScore error:", err.message)
    res.status(500).json({ error: "Failed to fetch score" })
  }
}
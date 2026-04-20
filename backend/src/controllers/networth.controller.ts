import { Request, Response } from "express"
import { fetchNetWorthHistory, captureBalanceSnapshots } from "../services/networth.service"
import { getUserId } from "../middleware/auth"

export async function getNetWorthHistory(req: Request, res: Response): Promise<void> {
  try {
    const userId = getUserId(req)
    const days = req.query.days ? parseInt(req.query.days as string, 10) : 90
    const result = await fetchNetWorthHistory(userId, days)
    res.json(result)
  } catch (err: any) {
    console.error("getNetWorthHistory:", err.message)
    res.status(500).json({ error: "Failed to fetch net worth history" })
  }
}

export async function takeSnapshot(req: Request, res: Response): Promise<void> {
  try {
    const userId = getUserId(req)
    const result = await captureBalanceSnapshots(userId)
    res.json({ ok: true, ...result })
  } catch (err: any) {
    console.error("takeSnapshot:", err.message)
    res.status(500).json({ error: "Failed to capture snapshot" })
  }
}

import { Request, Response } from "express"
import { fetchNetWorthHistory, captureBalanceSnapshots } from "../services/networth.service"
import { getPeriodStartDay } from "../services/user.service"
import { periodBoundaryDates } from "../lib/period"
import { getUserId } from "../middleware/auth"

export async function getNetWorthHistory(req: Request, res: Response): Promise<void> {
  try {
    const userId = getUserId(req)
    const [result, startDay] = await Promise.all([
      fetchNetWorthHistory(userId, req.query.range),
      getPeriodStartDay(userId),
    ])
    // M7.2: net worth keeps its day-based ranges; it only gains markers at the
    // first snapshot of each new period, so they sit on real data points.
    const periodMarkers = periodBoundaryDates(result.history.map((p) => p.date), startDay)
    res.json({ ...result, periodMarkers, periodStartDay: startDay })
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

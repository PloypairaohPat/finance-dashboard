import { Request, Response } from "express"
import { getUserId } from "../middleware/auth"
import { getPeriodStartDay, setPeriodStartDay } from "../services/user.service"
import { isValidPeriodStartDay, MIN_PERIOD_START_DAY, MAX_PERIOD_START_DAY } from "../lib/period"

// GET /user/settings
export async function getUserSettings(req: Request, res: Response): Promise<void> {
  try {
    const userId = getUserId(req)
    res.json({ periodStartDay: await getPeriodStartDay(userId) })
  } catch (err: any) {
    console.error("getUserSettings:", err.message)
    res.status(500).json({ error: "Failed to load settings" })
  }
}

// PUT /user/settings  { periodStartDay: number }
// Demo requests never get here: demoReadOnly answers every non-GET in demo mode.
export async function putUserSettings(req: Request, res: Response): Promise<void> {
  try {
    const userId = getUserId(req)
    const value = req.body?.periodStartDay
    // A JSON number only — "10" as a string is rejected rather than coerced.
    if (!isValidPeriodStartDay(value)) {
      res.status(400).json({
        error: `periodStartDay must be a whole number from ${MIN_PERIOD_START_DAY} to ${MAX_PERIOD_START_DAY}`,
      })
      return
    }
    const periodStartDay = await setPeriodStartDay(userId, value)
    res.json({ periodStartDay })
  } catch (err: any) {
    console.error("putUserSettings:", err.message)
    res.status(500).json({ error: "Failed to save settings" })
  }
}

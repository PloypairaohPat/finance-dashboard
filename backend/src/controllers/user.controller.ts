import { Request, Response } from "express"
import { getUserId } from "../middleware/auth"
import { getUserSettings as loadUserSettings, updateUserSettings } from "../services/user.service"
import { isValidPeriodStartDay, MIN_PERIOD_START_DAY, MAX_PERIOD_START_DAY } from "../lib/period"

// GET /user/settings
export async function getUserSettings(req: Request, res: Response): Promise<void> {
  try {
    const userId = getUserId(req)
    res.json(await loadUserSettings(userId))
  } catch (err: any) {
    console.error("getUserSettings:", err.message)
    res.status(500).json({ error: "Failed to load settings" })
  }
}

// PUT /user/settings  { periodStartDay?: number, paymentAppInflowsAreIncome?: boolean }
//
// Either field, or both. A field that isn't sent is left alone, so the dialog
// can save one setting without restating the other.
// Demo requests never get here: demoReadOnly answers every non-GET in demo mode.
export async function putUserSettings(req: Request, res: Response): Promise<void> {
  try {
    const userId = getUserId(req)
    const { periodStartDay, paymentAppInflowsAreIncome } = req.body ?? {}

    // JSON types only — "10" and "true" as strings are rejected, not coerced.
    if (periodStartDay !== undefined && !isValidPeriodStartDay(periodStartDay)) {
      res.status(400).json({
        error: `periodStartDay must be a whole number from ${MIN_PERIOD_START_DAY} to ${MAX_PERIOD_START_DAY}`,
      })
      return
    }
    if (paymentAppInflowsAreIncome !== undefined && typeof paymentAppInflowsAreIncome !== "boolean") {
      res.status(400).json({ error: "paymentAppInflowsAreIncome must be true or false" })
      return
    }
    if (periodStartDay === undefined && paymentAppInflowsAreIncome === undefined) {
      res.status(400).json({ error: "Nothing to save: send periodStartDay, paymentAppInflowsAreIncome, or both" })
      return
    }

    res.json(await updateUserSettings(userId, { periodStartDay, paymentAppInflowsAreIncome }))
  } catch (err: any) {
    console.error("putUserSettings:", err.message)
    res.status(500).json({ error: "Failed to save settings" })
  }
}

import { Request, Response } from "express"
import { getUserId } from "../middleware/auth"
import { getUserSettings as loadUserSettings, updateUserSettings } from "../services/user.service"
import { isValidPeriodStartDay, MIN_PERIOD_START_DAY, MAX_PERIOD_START_DAY } from "../lib/period"
import * as Sentry from "@sentry/node"
import { clerkClient } from "@clerk/express"
import { plaidClient } from "../lib/plaidClient"
import {
  DELETE_CONFIRMATION, DELETION_UNDERWAY_MESSAGE, DeletionError, DeletionUnderway, confirms, deleteUserData,
} from "../services/accountDeletion.service"

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

// PUT /user/settings  { periodStartDay?: number, paymentAppInflowsAreIncome?: boolean, missedPaycheckAlerts?: boolean }
//
// Either field, or both. A field that isn't sent is left alone, so the dialog
// can save one setting without restating the other.
// Demo requests never get here: demoReadOnly answers every non-GET in demo mode.
export async function putUserSettings(req: Request, res: Response): Promise<void> {
  try {
    const userId = getUserId(req)
    const { periodStartDay, paymentAppInflowsAreIncome, missedPaycheckAlerts } = req.body ?? {}

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
    if (missedPaycheckAlerts !== undefined && typeof missedPaycheckAlerts !== "boolean") {
      res.status(400).json({ error: "missedPaycheckAlerts must be true or false" })
      return
    }
    if (periodStartDay === undefined && paymentAppInflowsAreIncome === undefined && missedPaycheckAlerts === undefined) {
      res.status(400).json({ error: "Nothing to save: send periodStartDay, paymentAppInflowsAreIncome or missedPaycheckAlerts" })
      return
    }

    res.json(await updateUserSettings(userId, { periodStartDay, paymentAppInflowsAreIncome, missedPaycheckAlerts }))
  } catch (err: any) {
    console.error("putUserSettings:", err.message)
    res.status(500).json({ error: "Failed to save settings" })
  }
}

// ── "Delete account and all data" ─────────────────────────────────

export async function deleteMyAccount(req: Request, res: Response) {
  // The caller only: an id in the body is never read.
  const userId = getUserId(req)
  if (!confirms(req.body?.confirmation)) {
    res.status(400).json({ error: `Type "${DELETE_CONFIRMATION}" to confirm.` })
    return
  }
  try {
    const report = await deleteUserData(userId, { plaidClient, clerk: clerkClient.users })
    res.json({
      deleted: true,
      accountDeleted: report.clerkDeleted,
      ...(report.clerkDeleted ? {} : {
        message: 'Your data is deleted. Removing your sign-in account failed; you are signed out and it will be retried.',
      }),
    })
  } catch (err: any) {
    // Part-done after an Item left Plaid: still banned, reported, finished by hand.
    // Not an error: they can't sign in to try again.
    if (err instanceof DeletionUnderway) {
      res.json({ deleted: false, accountDeleted: false, pending: true, message: DELETION_UNDERWAY_MESSAGE })
      return
    }
    if (err instanceof DeletionError) {
      res.status(err.status).json({ error: err.message })
      return
    }
    Sentry.captureException(err)
    // Plaid removal may already have happened, so don't claim nothing changed.
    res.status(500).json({ error: "Deletion didn't finish. Your bank connections may already be disconnected; please try again." })
  }
}

import { Request, Response } from "express"
import { getUserId } from "../middleware/auth"
import { runDetectors, fetchActiveAlerts, fetchAllAlerts, dismissAlert } from "../services/alerts/dispatcher"
import { buildWeeklyDigest } from "../services/alerts/digest"

// Refresh detectors + return active alerts
export async function getAlerts(req: Request, res: Response) {
  try {
    const userId = getUserId(req)
    // Run detectors opportunistically on fetch. Cheap enough for a 1-user app;
    // for scale, move to an interval and just read here.
    await runDetectors(userId)
    res.json(await fetchActiveAlerts(userId))
  } catch (err: any) {
    console.error("getAlerts error:", err.message)
    res.status(500).json({ error: "Failed to fetch alerts" })
  }
}

export async function getAllAlerts(req: Request, res: Response) {
  try {
    res.json(await fetchAllAlerts(getUserId(req)))
  } catch (err: any) {
    console.error("getAllAlerts error:", err.message)
    res.status(500).json({ error: "Failed to fetch alerts" })
  }
}

export async function postDismissAlert(req: Request, res: Response) {
  try {
    await dismissAlert(getUserId(req), req.params.id as string)
    res.json({ success: true })
  } catch (err: any) {
    console.error("postDismissAlert error:", err.message)
    res.status(err.message === "Alert not found" ? 404 : 500)
       .json({ error: err.message })
  }
}

export async function getDigest(req: Request, res: Response) {
  try {
    res.json(await buildWeeklyDigest(getUserId(req)))
  } catch (err: any) {
    console.error("getDigest error:", err.message)
    res.status(500).json({ error: "Failed to fetch digest" })
  }
}
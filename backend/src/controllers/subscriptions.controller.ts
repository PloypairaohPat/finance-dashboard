import { Request, Response } from "express"
import { getUserId } from "../middleware/auth"
import { fetchSubscriptionAnalysis } from "../services/subscriptions.service"
import { plaidClient } from "../lib/plaidClient"   // adjust to your import path

export async function getSubscriptions(req: Request, res: Response) {
  try {
    const userId = getUserId(req)
    const data = await fetchSubscriptionAnalysis(userId, plaidClient)
    res.json(data)
  } catch (err: any) {
    console.error("getSubscriptions error:", err.message)
    res.status(500).json({ error: "Failed to fetch subscriptions" })
  }
}
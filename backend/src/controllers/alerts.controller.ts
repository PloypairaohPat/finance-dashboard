import { Request, Response } from "express"
import { fetchAlerts } from "../services/alerts.service"
import { getUserId } from "../middleware/auth"

export async function getAlerts(req: Request, res: Response): Promise<void> {
  try {
    const userId = getUserId(req)
    const alerts = await fetchAlerts()
    res.json({ alerts })
  } catch (err: any) {
    console.error("getAlerts:", err.message)
    res.status(500).json({ error: "Failed to fetch alerts" })
  }
}

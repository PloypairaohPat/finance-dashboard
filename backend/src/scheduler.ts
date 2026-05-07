import cron from "node-cron"
import { PlaidApi } from "plaid"
import prisma from "./lib/prisma"
import { triggerSync } from "./services/plaid.service"

export function startScheduler(plaidClient: PlaidApi) {
  // Run every 6 hours — daily-at-6am missed syncs when the process wasn't alive at that exact time
  cron.schedule("0 */6 * * *", async () => {
    console.log("⏰ [Cron] Scheduled sync starting...")

    try {
      const items = await prisma.plaidItem.findMany()

      if (items.length === 0) {
        console.log("⏰ [Cron] No Plaid items found, skipping.")
        return
      }

      const userIds = [...new Set(items.map(i => i.userId))]
      for (const userId of userIds) {
        try {
          const result = await triggerSync(plaidClient, userId)
          console.log(`⏰ [Cron] Synced user ${userId}: +${result.added} ~${result.modified} -${result.removed}`)
        } catch (err: any) {
          console.error(`⏰ [Cron] Sync failed for user ${userId}:`, err.message)
        }
      }

      console.log("⏰ [Cron] Scheduled sync complete.")
    } catch (err: any) {
      console.error("⏰ [Cron] Unexpected error:", err.message)
    }
  })

  console.log("⏰ Scheduler started — sync every 6 hours")
}
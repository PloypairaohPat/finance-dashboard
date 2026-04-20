import cron from "node-cron"
import { PlaidApi } from "plaid"
import prisma from "./lib/prisma"
import { syncTransactions } from "./services/plaidSync"
import { captureBalanceSnapshots } from "./services/networth.service"

export function startScheduler(plaidClient: PlaidApi) {
  // Run daily at 6:00 AM UTC
  cron.schedule("0 6 * * *", async () => {
    console.log("⏰ [Cron] Daily sync + snapshot starting...")

    try {
      const items = await prisma.plaidItem.findMany()

      if (items.length === 0) {
        console.log("⏰ [Cron] No Plaid items found, skipping.")
        return
      }

      for (const item of items) {
        try {
          const result = await syncTransactions(plaidClient, item.id)
          console.log(
            `⏰ [Cron] Synced item ${item.institutionName ?? item.id}: ` +
            `+${result.added} ~${result.modified} -${result.removed}`
          )
        } catch (err: any) {
          console.error(`⏰ [Cron] Sync failed for ${item.id}:`, err.message)
        }
      }

      const userIds = [...new Set(items.map(i => i.userId))]
      for (const userId of userIds) {
        try {
          const result = await captureBalanceSnapshots(userId)
          console.log(`⏰ [Cron] Snapshot for ${userId}:`, result)
        } catch (err: any) {
          console.error(`⏰ [Cron] Snapshot failed for ${userId}:`, err.message)
        }
      }

      console.log("⏰ [Cron] Daily sync + snapshot complete.")
    } catch (err: any) {
      console.error("⏰ [Cron] Unexpected error:", err.message)
    }
  })

  console.log("⏰ Scheduler started — daily sync at 06:00 UTC")
}
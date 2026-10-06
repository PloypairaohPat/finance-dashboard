import cron from "node-cron"
import * as Sentry from "@sentry/node"
import { PlaidApi } from "plaid"
import prisma from "./lib/prisma"
import { triggerSync } from "./services/plaid.service"
import { DEMO_USER_ID } from "./middleware/auth"
import { refreshStaleItems, STREAMS_STALE_HOURS } from "./services/recurringStreams.service"

export function startScheduler(plaidClient: PlaidApi) {
  // Run every 6 hours — daily-at-6am missed syncs when the process wasn't alive at that exact time
  cron.schedule("0 */6 * * *", async () => {
    console.log("⏰ [Cron] Scheduled sync starting...")

    try {
      const items = await prisma.plaidItem.findMany({
        where: { userId: { not: DEMO_USER_ID } },
      })

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
          Sentry.captureException(err)
          console.error(`⏰ [Cron] Sync failed for user ${userId}:`, err.message)
        }
      }

      console.log("⏰ [Cron] Scheduled sync complete.")
    } catch (err: any) {
      Sentry.captureException(err)
      console.error("⏰ [Cron] Unexpected error:", err.message)
    }
  })

  // Daily backstop for recurring streams (M7.6), an hour after the 06:00
  // sync: refreshes non-demo Items never refreshed or not refreshed in
  // STREAMS_STALE_HOURS, in case a webhook was missed. The webhook is the
  // primary trigger. One Item's failure is reported and the rest carry on.
  cron.schedule("0 7 * * *", async () => {
    try {
      const r = await refreshStaleItems(plaidClient)
      console.log(`🔁 [Cron] Recurring streams backstop: ${r.due} due (>${STREAMS_STALE_HOURS} h), ${r.refreshed} refreshed, ${r.failed} failed`)
    } catch (err: any) {
      Sentry.captureException(err)
      console.error("🔁 [Cron] Recurring streams backstop failed:", err.message)
    }
  })

  // Independent keepalive — prevents Supabase free-tier auto-pause after 7 days inactivity
  cron.schedule("0 0 * * *", async () => {
    try {
      await prisma.$queryRaw`SELECT 1`
      console.log("💓 [Cron] DB keepalive ping OK")
    } catch (err: any) {
      console.error("❌ [Cron] DB keepalive failed:", err.message)
    }
  })

  console.log("⏰ Scheduler started — sync every 6 hours, recurring streams backstop daily, keepalive every 24 hours")
}
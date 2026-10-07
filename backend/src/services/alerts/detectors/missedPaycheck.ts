import type { Detector } from "../types"
import { judgePaychecks } from "../../../lib/missedPaycheck"

/**
 * A salary stream's payday passed without pay (M7.6 PR 6b). The rules are in
 * lib/missedPaycheck.ts; the plan in docs/m7.6-missed-paycheck.md.
 *
 * Reads stored data only (ctx.paychecks, ctx.classified): no Plaid call when
 * the bell opens. An unreadable input answers for nothing: throwing leaves this
 * detector's alerts as they are instead of resolving them by absence.
 *
 * The old missedPaycheck (M5.8, removed in M7.3) read a field that never
 * existed and never fired; the doc lists what else it got wrong.
 */
export const detectMissedPaycheck: Detector = (ctx) => {
  if (!ctx.paychecks.ok) throw ctx.paychecks.error
  return judgePaychecks({ input: ctx.paychecks.input, rows: ctx.classified, activeAlerts: ctx.activeAlerts, now: ctx.now })
}

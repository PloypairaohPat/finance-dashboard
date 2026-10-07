// ─────────────────────────────────────────────────────────────────
//  markLabels — the transaction panel's "Mark as …" wording (M7.6 PR 5e).
//
//  A mark is a confirmation, and since the tab reads Plaid's streams a
//  confirmation can land in Bills as well as Subscriptions: the server says
//  which (membership's `landsIn`). Absent, it's a subscription, as before.
// ─────────────────────────────────────────────────────────────────

import type { MarkMembership } from "../types"

export interface MarkLabels {
  /** For a charge the tab already lists without a mark. */
  detected: string
  /** The button. */
  button: string
  /** The line under it. */
  help: string
}

export function markLabels(m: MarkMembership): MarkLabels {
  const landsIn = m.state === "unavailable" ? undefined : m.landsIn
  const bill = landsIn === "bill"
  const what = bill ? "a bill" : "a subscription"
  const list = bill ? "Bills" : "Subscriptions"
  const marked = m.state === "marked"
  return {
    detected: `Found automatically: it's under ${list} on the Subscriptions & Bills tab.`,
    button: marked ? `Marked as ${what} · Unmark` : `Mark as ${what}`,
    help: marked
      ? `Tracked under ${list} on the Subscriptions & Bills tab, through name changes and price changes. Unmarking removes only the mark.`
      : `Track this charge under ${list} on the Subscriptions & Bills tab, even when the merchant's name or price changes.`,
  }
}

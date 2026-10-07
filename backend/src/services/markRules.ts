// ─────────────────────────────────────────────────────────────────
//  markRules — what marks and verdicts share: the error a caller gets, and
//  the one rule both apply before confirming a charge. A module of its own so
//  subscriptionMarks.service can write through streamVerdicts.service
//  without the two importing each other.
// ─────────────────────────────────────────────────────────────────

import { classifyWindow } from "./classification.service"
import { getPeriodStartDay } from "./user.service"

/** A request the caller got wrong, with the HTTP status that says how. */
export class MarkError extends Error {
  constructor(public readonly status: 400 | 404 | 409, message: string) {
    super(message)
  }
}

const DAY_MS = 86_400_000

/** Whether the classifier counts this one row as spending. */
export async function isSpend(userId: string, tx: { id: string; date: Date }): Promise<{ spend: boolean; label: string }> {
  const startDay = await getPeriodStartDay(userId)
  const { rows } = await classifyWindow(userId, {
    since: tx.date, until: new Date(tx.date.getTime() + DAY_MS), startDay,
  })
  const verdict = rows.find(r => r.id === tx.id)?.verdict
  return { spend: verdict?.kind === "spend", label: verdict?.kind ?? "unclassified" }
}

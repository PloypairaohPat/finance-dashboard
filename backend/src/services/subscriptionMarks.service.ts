// ─────────────────────────────────────────────────────────────────
//  subscriptionMarks.service — "Mark as subscription" (or as a bill) from the
//  transaction panel, and un-marking.
//
//  Every function takes the caller's userId and checks the transaction or
//  mark belongs to them BEFORE anything else, answering 404 otherwise, so an
//  id from another user can't be told apart from one that doesn't exist. The
//  database backs this up: a mark's foreign key is (transactionId, userId),
//  so a mark can't point at another user's transaction at all.
//
//  Since M7.6 PR 5e a mark is a confirmation, written through the verdict
//  writer (streamVerdicts.service): one answer per stream, under the per-user
//  lock. On a charge in a stream it anchors on the stream's newest posted
//  charge, as Confirm on the tab does; where it lands — Subscriptions or
//  Bills — follows the sorting definition, and the panel says which.
// ─────────────────────────────────────────────────────────────────

import prisma from "../lib/prisma"
import { MarkError, isSpend } from "./markRules"
import { composeSubscriptions } from "./streamComposition.service"
import { writeVerdict } from "./streamVerdicts.service"

export { MarkError, isSpend }

type Lands = "subscription" | "bill"

export type Membership =
  | { state: "marked"; markId: string; landsIn: Lands }
  | { state: "detected"; landsIn: Lands }
  | { state: "markable"; landsIn: Lands }
  | { state: "unavailable"; reason: string }

const PENDING_REASON =
  "This charge is still pending. A pending row gets a new id when it posts, so a mark on it would be lost; mark it once it has posted."

async function ownTransaction(userId: string, transactionId: unknown) {
  if (typeof transactionId !== "string" || transactionId === "") {
    throw new MarkError(400, "transactionId is required.")
  }
  const tx = await prisma.transaction.findFirst({
    where: { id: transactionId, userId, deletedAt: null },
    select: { id: true, date: true, pending: true },
  })
  if (!tx) throw new MarkError(404, "Transaction not found")
  return tx
}

/** Where a charge stands, and the charge a confirmation of it anchors on. */
async function locate(userId: string, tx: { id: string; date: Date; pending: boolean }): Promise<{ membership: Membership; anchor: string }> {
  const analysis = await composeSubscriptions(userId)
  const shown = [...analysis.subscriptions, ...analysis.bills]
  const lands = (kind: string): Lands => (kind === "bill" ? "bill" : "subscription")

  const marked = shown.find(s => s.mark && s.txIds.includes(tx.id))
  if (marked) return { membership: { state: "marked", markId: marked.mark!.id, landsIn: lands(marked.kind) }, anchor: tx.id }
  const detected = shown.find(s => !s.mark && s.txIds.includes(tx.id))
  if (detected) return { membership: { state: "detected", landsIn: lands(detected.kind) }, anchor: tx.id }
  if (tx.pending) return { membership: { state: "unavailable", reason: PENDING_REASON }, anchor: tx.id }
  if (!(await isSpend(userId, tx)).spend) {
    return { membership: { state: "unavailable", reason: "Only spending can be a subscription or a bill." }, anchor: tx.id }
  }
  // A suggested or dismissed stream: confirming lands it where the sorting says,
  // anchored on its newest posted charge. Otherwise a mark of its own, as before.
  const stream = [...(analysis.suggested ?? []), ...(analysis.dismissed ?? [])].find(s => s.txIds.includes(tx.id))
  if (stream) return { membership: { state: "markable", landsIn: stream.confirmsAs }, anchor: stream.anchorTxId ?? tx.id }
  return { membership: { state: "markable", landsIn: "subscription" }, anchor: tx.id }
}

/** Where a transaction stands, for the detail panel. Throws 404 for another user's. */
export async function membershipOf(userId: string, transactionId: unknown): Promise<Membership> {
  const tx = await ownTransaction(userId, transactionId)
  return (await locate(userId, tx)).membership
}

/**
 * Mark a charge: a confirmation. Marking a charge that already belongs to a
 * marked subscription or bill returns that mark rather than adding a second.
 */
export async function createMark(
  userId: string,
  transactionId: unknown,
): Promise<{ mark: { id: string; transactionId: string; createdAt: Date }; created: boolean }> {
  // Ownership first: nothing below runs for another user's transaction.
  const tx = await ownTransaction(userId, transactionId)
  const { membership, anchor } = await locate(userId, tx)
  if (membership.state === "marked") {
    const mark = await prisma.subscriptionMark.findFirstOrThrow({
      where: { id: membership.markId, userId, kind: "confirmed" },
      select: { id: true, transactionId: true, createdAt: true },
    })
    return { mark, created: false }
  }
  if (membership.state === "unavailable") throw new MarkError(409, membership.reason)

  const v = await writeVerdict(userId, anchor, "confirmed")
  return { mark: { id: v.id, transactionId: v.transactionId, createdAt: v.createdAt }, created: true }
}

/** Un-mark: remove the mark and nothing else. 404 for another user's mark, or a dismissal. */
export async function deleteMark(userId: string, markId: string): Promise<void> {
  const { count } = await prisma.subscriptionMark.deleteMany({ where: { id: markId, userId, kind: "confirmed" } })
  if (count === 0) throw new MarkError(404, "Mark not found")
}

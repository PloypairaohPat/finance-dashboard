// ─────────────────────────────────────────────────────────────────
//  subscriptionMarks.service — "Mark as subscription", and un-marking.
//
//  Every function takes the caller's userId and checks the transaction or
//  mark belongs to them BEFORE anything else, answering 404 otherwise, so an
//  id from another user can't be told apart from one that doesn't exist. The
//  database backs this up: a mark's foreign key is (transactionId, userId),
//  so a mark can't point at another user's transaction at all.
//
//  A mark stores only its anchor. What it covers — the merchant, the
//  schedule, the charges — is derived on every read in subscriptions.service.
// ─────────────────────────────────────────────────────────────────

import { Prisma } from "@prisma/client"
import prisma from "../lib/prisma"
import { classifyWindow } from "./classification.service"
import { analyseStoredSubscriptions } from "./subscriptions.service"
import { getPeriodStartDay } from "./user.service"

/** A request the caller got wrong, with the HTTP status that says how. */
export class MarkError extends Error {
  constructor(public readonly status: 400 | 404 | 409, message: string) {
    super(message)
  }
}

export type Membership =
  | { state: "marked"; markId: string }
  | { state: "detected" }
  | { state: "markable" }
  | { state: "unavailable"; reason: string }

const DAY_MS = 86_400_000

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

/** Whether the classifier counts this one row as spending. */
async function isSpend(userId: string, tx: { id: string; date: Date }): Promise<{ spend: boolean; label: string }> {
  const startDay = await getPeriodStartDay(userId)
  const { rows } = await classifyWindow(userId, {
    since: tx.date, until: new Date(tx.date.getTime() + DAY_MS), startDay,
  })
  const verdict = rows.find(r => r.id === tx.id)?.verdict
  return { spend: verdict?.kind === "spend", label: verdict?.kind ?? "unclassified" }
}

/** Where a transaction stands, for the detail panel. Throws 404 for another user's. */
export async function membershipOf(userId: string, transactionId: unknown): Promise<Membership> {
  const tx = await ownTransaction(userId, transactionId)
  const analysis = await analyseStoredSubscriptions(userId)
  const streams = [...analysis.subscriptions, ...analysis.bills]
  const marked = streams.find(s => s.mark && s.txIds.includes(tx.id))
  if (marked) return { state: "marked", markId: marked.mark!.id }
  if (streams.some(s => !s.mark && s.txIds.includes(tx.id))) return { state: "detected" }
  if (tx.pending) return { state: "unavailable", reason: PENDING_REASON }
  if (!(await isSpend(userId, tx)).spend) {
    return { state: "unavailable", reason: "Only spending can be a subscription." }
  }
  return { state: "markable" }
}

/**
 * Mark a charge as a subscription. Marking a charge that already belongs to a
 * marked subscription returns that mark rather than adding a second.
 */
export async function createMark(
  userId: string,
  transactionId: unknown,
): Promise<{ mark: { id: string; transactionId: string; createdAt: Date }; created: boolean }> {
  // Ownership first: nothing below runs for another user's transaction.
  const tx = await ownTransaction(userId, transactionId)
  const membership = await membershipOf(userId, tx.id)
  if (membership.state === "marked") {
    const mark = await prisma.subscriptionMark.findFirstOrThrow({
      where: { id: membership.markId, userId, kind: "confirmed" },
      select: { id: true, transactionId: true, createdAt: true },
    })
    return { mark, created: false }
  }
  if (membership.state === "unavailable") throw new MarkError(409, membership.reason)

  try {
    const mark = await prisma.subscriptionMark.create({
      data: { userId, transactionId: tx.id, kind: "confirmed" },
      select: { id: true, transactionId: true, createdAt: true },
    })
    return { mark, created: true }
  } catch (e) {
    // Two requests marking the same charge at once: the second finds the first's.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const mark = await prisma.subscriptionMark.findFirstOrThrow({
        where: { userId, transactionId: tx.id, kind: "confirmed" },
        select: { id: true, transactionId: true, createdAt: true },
      })
      return { mark, created: false }
    }
    throw e
  }
}

/** Un-mark: remove the mark and nothing else. 404 for another user's mark, or a dismissal. */
export async function deleteMark(userId: string, markId: string): Promise<void> {
  const { count } = await prisma.subscriptionMark.deleteMany({ where: { id: markId, userId, kind: "confirmed" } })
  if (count === 0) throw new MarkError(404, "Mark not found")
}

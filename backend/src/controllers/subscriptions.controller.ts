import { Request, Response } from "express"
import { getUserId } from "../middleware/auth"
import { fetchSubscriptionAnalysis } from "../services/subscriptions.service"
import { MarkError, createMark, deleteMark, membershipOf } from "../services/subscriptionMarks.service"
import { deleteVerdict, writeVerdict } from "../services/streamVerdicts.service"

export async function getSubscriptions(req: Request, res: Response) {
  try {
    const userId = getUserId(req)
    const data = await fetchSubscriptionAnalysis(userId)
    res.json(data)
  } catch (err: any) {
    console.error("getSubscriptions error:", err.message)
    res.status(500).json({ error: "Failed to fetch subscriptions" })
  }
}
// ── "Mark as subscription" ────────────────────────────────────────

function sendMarkError(res: Response, err: any, what: string) {
  if (err instanceof MarkError) return res.status(err.status).json({ error: err.message })
  console.error(`${what} error:`, err?.message)
  return res.status(500).json({ error: `Failed to ${what}` })
}

export async function getMarkMembership(req: Request, res: Response) {
  try {
    res.json(await membershipOf(getUserId(req), req.params.transactionId))
  } catch (err: any) {
    sendMarkError(res, err, "read subscription mark")
  }
}

export async function postMark(req: Request, res: Response) {
  try {
    const { mark, created } = await createMark(getUserId(req), req.body?.transactionId)
    res.status(created ? 201 : 200).json({ mark })
  } catch (err: any) {
    sendMarkError(res, err, "mark subscription")
  }
}

export async function removeMark(req: Request, res: Response) {
  try {
    await deleteMark(getUserId(req), req.params.id as string)
    res.json({ ok: true })
  } catch (err: any) {
    sendMarkError(res, err, "remove subscription mark")
  }
}

// ── Confirm and Dismiss (M7.6 PR 5c) ──────────────────────────────

// POST /subscriptions/verdicts  { transactionId, verdict: "confirmed" | "dismissed" }
export async function postVerdict(req: Request, res: Response) {
  try {
    const verdict = await writeVerdict(getUserId(req), req.body?.transactionId, req.body?.verdict)
    res.status(201).json({ verdict })
  } catch (err: any) {
    sendMarkError(res, err, "record verdict")
  }
}

// DELETE /subscriptions/verdicts/:id — undo a confirmation, or Restore a dismissal.
export async function removeVerdict(req: Request, res: Response) {
  try {
    await deleteVerdict(getUserId(req), req.params.id as string)
    res.json({ ok: true })
  } catch (err: any) {
    sendMarkError(res, err, "remove verdict")
  }
}

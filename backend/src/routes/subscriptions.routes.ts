import { Router } from "express"
import { requireSession } from "../middleware/auth"
import { getSubscriptions, getMarkMembership, postMark, postVerdict, removeMark, removeVerdict } from "../controllers/subscriptions.controller"

const router = Router()
router.get("/", requireSession, getSubscriptions)
// "Mark as subscription". Writes go through demoReadOnly like every other.
router.get("/marks/membership/:transactionId", requireSession, getMarkMembership)
router.post("/marks", requireSession, postMark)
router.delete("/marks/:id", requireSession, removeMark)
// Confirm and Dismiss (M7.6 PR 5c): nothing in the app calls these until PR 5d.
router.post("/verdicts", requireSession, postVerdict)
router.delete("/verdicts/:id", requireSession, removeVerdict)
export default router

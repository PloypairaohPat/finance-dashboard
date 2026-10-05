import { Router } from "express"
import { requireSession } from "../middleware/auth"
import { getSubscriptions, getMarkMembership, postMark, removeMark } from "../controllers/subscriptions.controller"

const router = Router()
router.get("/", requireSession, getSubscriptions)
// "Mark as subscription". Writes go through demoReadOnly like every other.
router.get("/marks/membership/:transactionId", requireSession, getMarkMembership)
router.post("/marks", requireSession, postMark)
router.delete("/marks/:id", requireSession, removeMark)
export default router

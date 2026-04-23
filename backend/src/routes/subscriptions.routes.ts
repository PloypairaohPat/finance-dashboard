import { Router } from "express"
import { requireSession } from "../middleware/auth"
import { getSubscriptions } from "../controllers/subscriptions.controller"

const router = Router()
router.get("/", requireSession, getSubscriptions)
export default router
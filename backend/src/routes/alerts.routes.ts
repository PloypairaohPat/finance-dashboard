import { Router } from "express"
import { requireSession } from "../middleware/auth"
import { getAlerts, getAllAlerts, postDismissAlert, getDigest } from "../controllers/alerts.controller"

const router = Router()
router.get("/", requireSession, getAlerts)
router.get("/all", requireSession, getAllAlerts)
router.get("/digest", requireSession, getDigest)
router.post("/:id/dismiss", requireSession, postDismissAlert)
export default router
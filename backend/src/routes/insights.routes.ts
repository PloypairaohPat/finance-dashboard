import { Router } from "express"
import { requireSession } from "../middleware/auth"
import { getInsights } from "../controllers/insights.controller"

const router = Router()
router.get("/", requireSession, getInsights)
export default router
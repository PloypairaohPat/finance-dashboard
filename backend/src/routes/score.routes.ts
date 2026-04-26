import { Router } from "express"
import { requireSession } from "../middleware/auth"
import { getScore } from "../controllers/score.controller"

const router = Router()
router.get("/", requireSession, getScore)
export default router
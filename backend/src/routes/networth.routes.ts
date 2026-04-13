import { Router } from "express"
import { getNetWorthHistory, takeSnapshot } from "../controllers/networth.controller"

const router = Router()
router.get("/", getNetWorthHistory)
router.post("/snapshot", takeSnapshot)

export default router
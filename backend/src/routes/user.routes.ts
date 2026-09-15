import { Router } from "express"
import { getUserSettings, putUserSettings } from "../controllers/user.controller"

// Mounted at /user behind requireSession (app.ts).
const router = Router()
router.get("/settings", getUserSettings)
router.put("/settings", putUserSettings)
export default router

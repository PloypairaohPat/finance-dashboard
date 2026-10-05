import { Router } from "express"
import { deleteMyAccount, getUserSettings, putUserSettings } from "../controllers/user.controller"

// Mounted at /user behind requireSession (app.ts).
const router = Router()
router.get("/settings", getUserSettings)
router.put("/settings", putUserSettings)
// "Delete account and all data": the caller only, with the typed phrase. A write,
// so demoReadOnly refuses it in demo mode.
router.delete("/", deleteMyAccount)
export default router

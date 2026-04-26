import { Router } from "express"
import { requireSession } from "../middleware/auth"
import { getGoals, postGoal, patchGoal, removeGoal } from "../controllers/goals.controller"

const router = Router()
router.get("/", requireSession, getGoals)
router.post("/", requireSession, postGoal)
router.patch("/:id", requireSession, patchGoal)
router.delete("/:id", requireSession, removeGoal)
export default router

// server.ts:
// import goalsRoutes from "./routes/goals.routes"
// app.use("/goals", goalsRoutes)
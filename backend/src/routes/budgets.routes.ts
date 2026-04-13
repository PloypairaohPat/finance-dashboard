import { Router } from "express"
import {
  createOrUpdateBudget,
  getBudgets,
  getBudgetStatus,
} from "../controllers/budgets.controller"

const router = Router()

router.post("/",       createOrUpdateBudget)
router.get("/",        getBudgets)
router.get("/status",  getBudgetStatus)

export default router
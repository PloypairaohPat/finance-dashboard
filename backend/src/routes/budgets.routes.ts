import { Router } from "express"
import {
  createOrUpdateBudget,
  getBudgets,
  getBudgetStatus,
  getCategoryList,
  removeBudget,
} from "../controllers/budgets.controller"

const router = Router()

router.post("/", createOrUpdateBudget)
router.get("/", getBudgets)
router.get("/status", getBudgetStatus)
router.get("/categories", getCategoryList)
router.delete("/:id", removeBudget)

export default router

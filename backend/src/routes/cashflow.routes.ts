import { Router } from "express"
import { getCashFlow } from "../controllers/cashflow.controller"

const router = Router()

router.get("/", getCashFlow)

export default router
import { Router }                                      from 'express'
import { getTransactions, getCategories, getTrends }   from '../controllers/transactions.controller'
import { searchTransactionsHandler, patchTransaction } from "../controllers/transactions.controller"

const router = Router()

router.get('/',           getTransactions)
router.get('/categories', getCategories)
router.get('/trends',     getTrends)

export default router

// Add BEFORE any /:id routes — order matters!
router.get("/search", searchTransactionsHandler)
router.patch("/:id", patchTransaction)
import { Router } from 'express'
import {
  getTransactions,
  getCategories,
  getCategoryComparison,
  getTrends,
  searchTransactionsHandler,
  patchTransaction,
} from '../controllers/transactions.controller'

const router = Router()

router.get('/',                    getTransactions)
router.get('/categories',          getCategories)
router.get('/categories/comparison', getCategoryComparison)
router.get('/trends',              getTrends)
router.get('/search',              searchTransactionsHandler)
router.patch('/:id',               patchTransaction)

export default router
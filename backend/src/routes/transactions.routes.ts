import { Router } from 'express'
import {
  getTransactions,
  getCategories,
  getCategoryComparison,
  getTrends,
  getTransactionSearch,
  patchTransaction,
  getUserTags,
} from '../controllers/transactions.controller'

const router = Router()

router.get('/',                      getTransactions)
router.get('/categories',            getCategories)
router.get('/categories/comparison', getCategoryComparison)
router.get('/trends',                getTrends)
router.get('/search',                getTransactionSearch)
router.get('/tags',                  getUserTags)
router.patch('/:id',                 patchTransaction)

export default router

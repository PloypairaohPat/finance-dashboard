import { Router }                                      from 'express'
import { getTransactions, getCategories, getTrends }   from '../controllers/transactions.controller'

const router = Router()

router.get('/',           getTransactions)
router.get('/categories', getCategories)
router.get('/trends',     getTrends)

export default router
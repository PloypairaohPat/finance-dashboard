import { Router }                            from 'express'
import { getTransactions, getCategories }    from '../controllers/transactions.controller'

const router = Router()

router.get('/',           getTransactions)
router.get('/categories', getCategories)

export default router
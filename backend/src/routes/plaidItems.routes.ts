import { Router } from 'express'
import { PlaidApi } from 'plaid'
import { makePlaidItemsController } from '../controllers/plaidItems.controller'
import { requireSession } from '../middleware/auth'

export function makePlaidItemsRouter(plaidClient: PlaidApi) {
  const router     = Router()
  const controller = makePlaidItemsController(plaidClient)

  router.get('/', requireSession, controller.getPlaidItems.bind(controller))
  router.delete('/:id', requireSession, controller.deletePlaidItem.bind(controller))

  return router
}

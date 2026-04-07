import { Router }                    from 'express'
import { PlaidApi }                  from 'plaid'
import { makeRecurringController }   from '../controllers/recurring.controller'

export function makeRecurringRouter(plaidClient: PlaidApi) {
  const router     = Router()
  const controller = makeRecurringController(plaidClient)

  router.get('/', controller.getRecurring.bind(controller))

  return router
}
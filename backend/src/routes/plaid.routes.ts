import { Router } from 'express'
import { PlaidApi, Products, CountryCode } from 'plaid'
import { makePlaidController } from '../controllers/plaid.controller'
import { requireSession } from '../middleware/auth'

export function makePlaidRouter(
  plaidClient: PlaidApi,
  products: Products[],
  countryCodes: CountryCode[]
) {
  const router = Router()
  const controller = makePlaidController(plaidClient, products, countryCodes)

  router.post('/create_link_token', requireSession, controller.getLinkToken.bind(controller))
  router.post('/exchange_public_token', requireSession, controller.exchangeToken.bind(controller))
  router.post('/sync', requireSession, controller.sync.bind(controller))
  router.post('/webhook', controller.webhook.bind(controller))

  return router
}
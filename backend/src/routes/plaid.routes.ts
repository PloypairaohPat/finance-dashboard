import { Router }              from 'express'
import { PlaidApi, Products, CountryCode } from 'plaid'
import { makePlaidController } from '../controllers/plaid.controller'

export function makePlaidRouter(
  plaidClient:  PlaidApi,
  products:     Products[],
  countryCodes: CountryCode[]
) {
  const router     = Router()
  const controller = makePlaidController(plaidClient, products, countryCodes)

  router.post('/create_link_token',   controller.getLinkToken.bind(controller))
  router.post('/exchange_public_token', controller.exchangeToken.bind(controller))
  router.post('/sync',                controller.sync.bind(controller))
  router.post('/webhook',             controller.webhook.bind(controller))

  return router
}
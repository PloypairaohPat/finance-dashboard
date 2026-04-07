import { Request, Response }  from 'express'
import { PlaidApi, Products, CountryCode } from 'plaid'
import {
  createLinkToken,
  exchangePublicToken,
  triggerSync,
} from '../services/plaid.service'

export function makePlaidController(
  plaidClient:  PlaidApi,
  products:     Products[],
  countryCodes: CountryCode[]
) {
  return {
    async getLinkToken(
      req: Request<{}, {}, { userId?: string }>,
      res: Response
    ) {
      try {
        const link_token = await createLinkToken(plaidClient, products, countryCodes, req.body.userId)
        console.log(`✅ link_token created for user: ${req.body.userId || 'default'}`)
        res.json({ link_token })
      } catch (err: any) {
        console.error('❌ getLinkToken:', err.response?.data || err.message)
        res.status(500).json({ error: err.response?.data || err.message })
      }
    },

    async exchangeToken(
      req: Request<{}, {}, { public_token: string }>,
      res: Response
    ) {
      try {
        const result = await exchangePublicToken(plaidClient, req.body.public_token)
        res.json({ success: true, institutionName: result.institutionName })
      } catch (err: any) {
        console.error('❌ exchangeToken:', err.response?.data || err.message)
        res.status(500).json({ error: 'Failed to exchange token' })
      }
    },

    async sync(_req: Request, res: Response) {
      try {
        const result = await triggerSync(plaidClient)
        res.json(result)
      } catch (err: any) {
        console.error('❌ sync:', err.message)
        res.status(500).json({ error: err.message })
      }
    },

    async webhook(
      req: Request<{}, {}, {
        webhook_type?: string
        webhook_code?: string
        item_id?:      string
        error?:        unknown
      }>,
      res: Response
    ) {
      const { webhook_type, webhook_code, item_id } = req.body
      console.log(`📨 Webhook: ${webhook_type}/${webhook_code} — item: ${item_id}`)
      res.json({ received: true })

      // Fire-and-forget sync after responding
      if (webhook_type === 'TRANSACTIONS') {
        if (
          webhook_code === 'SYNC_UPDATES_AVAILABLE' ||
          webhook_code === 'INITIAL_UPDATE' ||
          webhook_code === 'HISTORICAL_UPDATE'
        ) {
          triggerSync(plaidClient).catch((err: any) =>
            console.error('❌ Webhook sync error:', err.message)
          )
        }
      }

      if (webhook_type === 'ITEM' && webhook_code === 'ERROR') {
        console.error(`❌ Plaid item error for ${item_id}:`, req.body.error)
      }
    },
  }
}
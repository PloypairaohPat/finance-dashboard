import { Request, Response }  from 'express'
import { PlaidApi, Products, CountryCode } from 'plaid'
import {
  createLinkToken,
  createUpdateLinkToken,
  exchangePublicToken,
  triggerSync,
} from '../services/plaid.service'
import { getUserId } from '../middleware/auth'
import { verifyPlaidWebhook } from '../utils/verifyPlaidWebhook'

export function makePlaidController(
  plaidClient:  PlaidApi,
  products:     Products[],
  countryCodes: CountryCode[]
) {
  return {
    async getLinkToken(req: Request, res: Response) {
      try {
        const userId = getUserId(req)
        const link_token = await createLinkToken(plaidClient, products, countryCodes, userId)
        console.log(`✅ link_token created for user: ${userId}`)
        res.json({ link_token })
      } catch (err: any) {
        console.error('❌ getLinkToken:', err.response?.data || err.message)
        res.status(500).json({ error: err.response?.data || err.message })
      }
    },

    async getUpdateLinkToken(req: Request, res: Response) {
      try {
        const userId = getUserId(req)
        const link_token = await createUpdateLinkToken(plaidClient, userId, countryCodes)
        console.log(`✅ update link_token created for user: ${userId}`)
        res.json({ link_token })
      } catch (err: any) {
        console.error('❌ getUpdateLinkToken:', err.response?.data || err.message)
        res.status(500).json({ error: err.message })
      }
    },

    async exchangeToken(req: Request, res: Response) {
      try {
        const userId = getUserId(req)
        const result = await exchangePublicToken(plaidClient, req.body.public_token, userId)
        res.json({ success: true, institutionName: result.institutionName })
      } catch (err: any) {
        console.error('❌ exchangeToken:', err.response?.data || err.message)
        res.status(500).json({ error: 'Failed to exchange token' })
      }
    },

    async sync(req: Request, res: Response) {
      try {
        const userId = getUserId(req)
        const result = await triggerSync(plaidClient, userId)
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
      const verified = await verifyPlaidWebhook(
        plaidClient,
        req.header('Plaid-Verification'),
        (req as any).rawBody
      )
      if (!verified) {
        console.warn('⚠️  Webhook rejected: invalid signature')
        res.status(401).json({ error: 'Invalid webhook signature' })
        return
      }

      const { webhook_type, webhook_code, item_id } = req.body
      console.log(`📨 Webhook: ${webhook_type}/${webhook_code} — item: ${item_id}`)
      res.json({ received: true })

      if (webhook_type === 'TRANSACTIONS') {
        if (
          webhook_code === 'SYNC_UPDATES_AVAILABLE' ||
          webhook_code === 'INITIAL_UPDATE' ||
          webhook_code === 'HISTORICAL_UPDATE'
        ) {
          // Webhook doesn't have auth context — look up userId from the item
          if (item_id) {
            const plaidItem = await (await import('../lib/prisma')).default.plaidItem.findUnique({
              where: { itemId: item_id },
            })
            if (plaidItem) {
              triggerSync(plaidClient, plaidItem.userId).catch((err: any) =>
                console.error('❌ Webhook sync error:', err.message)
              )
            }
          }
        }
      }

      if (webhook_type === 'ITEM' && webhook_code === 'ERROR') {
        console.error(`❌ Plaid item error for ${item_id}:`, req.body.error)
      }
    },
  }
}

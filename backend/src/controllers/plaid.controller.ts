import { Request, Response }  from 'express'
import * as Sentry from '@sentry/node'
import { PlaidApi, Products, CountryCode } from 'plaid'
import {
  createLinkToken,
  createUpdateLinkToken,
  exchangePublicToken,
  triggerSync,
} from '../services/plaid.service'
import { getUserId } from '../middleware/auth'
import { verifyPlaidWebhook } from '../utils/verifyPlaidWebhook'
import { classifyPlaidError } from '../utils/plaidErrors'

// ── Webhook observability ────────────────────────────────────────────
// One JSON object per line, so Railway's log search can filter on
// `plaid.webhook` and on the outcome field.
//
// NEVER add the Plaid-Verification JWT, the raw body, or any access token
// to these fields. Everything logged here is either a non-secret enum
// (webhook_type/code) or a deliberately truncated item id.

const LOG_FIELD_MAX = 64

// Until verification passes, the body is attacker-controlled. Bounding each
// field stops a forged request from flooding the log stream; JSON.stringify
// escapes newlines, which keeps one event on exactly one line.
function safeField(value: unknown): string | null {
  return typeof value === 'string' ? value.slice(0, LOG_FIELD_MAX) : null
}

// Enough to correlate against Plaid's dashboard, not enough to be a usable
// identifier on its own.
function truncateItemId(itemId: unknown): string | null {
  const safe = safeField(itemId)
  if (safe === null) return null
  return safe.length <= 8 ? safe : `${safe.slice(0, 8)}…`
}

interface WebhookLogFields {
  outcome:       'verified' | 'rejected'
  webhook_type?: unknown
  webhook_code?: unknown
  item_id?:      unknown
  reason?:       string
}

function logPlaidWebhook({ outcome, webhook_type, webhook_code, item_id, reason }: WebhookLogFields) {
  const line = JSON.stringify({
    evt:          'plaid.webhook',
    outcome,
    reason:       reason ?? undefined,
    webhook_type: safeField(webhook_type),
    webhook_code: safeField(webhook_code),
    item_id:      truncateItemId(item_id),
  })

  // Rejections go to stderr so a forged or misconfigured request stands out
  // at a different severity in Railway, not just by its outcome field.
  if (outcome === 'rejected') console.warn(line)
  else console.log(line)
}

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
        const itemId = typeof req.body?.itemId === 'string' ? req.body.itemId : undefined
        const link_token = await createUpdateLinkToken(plaidClient, userId, countryCodes, itemId)
        console.log(`✅ update link_token created for user: ${userId}`)
        res.json({ link_token })
      } catch (err: any) {
        console.error('❌ getUpdateLinkToken:', err.response?.data || err.message)
        res.status(err.message === 'PlaidItem not found' ? 404 : 500)
           .json({ error: err.message })
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
      // Verification runs before any logging, DB access, or response — the
      // body below is untrusted input until this resolves true.
      const verificationHeader = req.header('Plaid-Verification')
      const verified = await verifyPlaidWebhook(
        plaidClient,
        verificationHeader,
        (req as any).rawBody
      )

      const { webhook_type, webhook_code, item_id } = req.body

      if (!verified) {
        logPlaidWebhook({
          outcome: 'rejected',
          // Distinguishes a forged/tampered request from the far more common
          // cause: something in front of Plaid stripped the header, or the
          // endpoint was hit by a scanner.
          reason: verificationHeader ? 'signature_invalid' : 'missing_verification_header',
          webhook_type,
          webhook_code,
          item_id,
        })
        res.status(401).json({ error: 'Invalid webhook signature' })
        return
      }

      logPlaidWebhook({ outcome: 'verified', webhook_type, webhook_code, item_id })
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
              triggerSync(plaidClient, plaidItem.userId).catch((err: any) => {
                Sentry.captureException(err)
                console.error('❌ Webhook sync error:', err.message)
              })
            }
          }
        }
      }

      if (
        webhook_type === 'ITEM' &&
        (webhook_code === 'ERROR' ||
          webhook_code === 'PENDING_EXPIRATION' ||
          webhook_code === 'USER_PERMISSION_REVOKED')
      ) {
        if (item_id) {
          const prisma = (await import('../lib/prisma')).default
          const plaidItem = await prisma.plaidItem.findUnique({ where: { itemId: item_id } })
          if (plaidItem) {
            let status: 'login_required' | 'pending_expiration' | 'revoked' | 'error'
            let errorCode: string | null = null

            if (webhook_code === 'ERROR') {
              const classified = classifyPlaidError(req.body.error)
              status    = classified.status
              errorCode = classified.errorCode ?? null
            } else if (webhook_code === 'PENDING_EXPIRATION') {
              status = 'pending_expiration'
            } else {
              status = 'revoked'
            }

            await prisma.plaidItem.update({
              where: { id: plaidItem.id },
              data:  { status, errorCode, lastErrorAt: new Date() },
            })

            Sentry.captureMessage(
              `Plaid ITEM/${webhook_code} for item ${item_id} → status=${status}${errorCode ? ` (${errorCode})` : ''}`,
              webhook_code === 'PENDING_EXPIRATION' ? 'warning' : 'error'
            )
            // Sentry above keeps the full item_id (access-controlled, and needed
            // to act on the alert); the Railway log stream gets the short form.
            console.error(
              `❌ Plaid ITEM/${webhook_code} for ${truncateItemId(item_id)} → status=${status}`,
              req.body.error ?? '',
            )
          }
        }
      }
    },
  }
}

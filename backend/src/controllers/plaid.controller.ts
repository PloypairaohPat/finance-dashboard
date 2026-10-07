import { Request, Response }  from 'express'
import * as Sentry from '@sentry/node'
import { PlaidApi, Products, CountryCode } from 'plaid'
import {
  createLinkToken,
  createUpdateLinkToken,
  exchangePublicToken,
  triggerSync,
  LinkRefused,
  type LinkAccount,
} from '../services/plaid.service'
import { getUserId } from '../middleware/auth'
import { verifyPlaidWebhook } from '../utils/verifyPlaidWebhook'
import { classifyPlaidError } from '../utils/plaidErrors'
import { recordAudit } from '../lib/auditLog'
import { firstRefreshIfNeeded, refreshAfterSync, refreshOnRecurringUpdate } from '../services/recurringStreams.service'

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

/** Link's onSuccess metadata, as the browser sent it. Untrusted: a cost and UX guard only. */
function linkMetadata(body: any) {
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null)
  const accounts: LinkAccount[] = Array.isArray(body?.accounts)
    ? body.accounts.slice(0, 50).map((a: any) => ({ name: str(a?.name), mask: str(a?.mask), subtype: str(a?.subtype) }))
    : []
  return { institutionId: str(body?.institution_id), accounts, confirmedNewLogin: body?.confirmedNewLogin === true }
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
        // Account selection: the "same login, other accounts" answer to a
        // second link at a bank the user already has.
        const accountSelection = req.body?.accountSelection === true
        const link_token = await createUpdateLinkToken(plaidClient, userId, countryCodes, itemId, { accountSelection })
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
        const result = await exchangePublicToken(plaidClient, req.body.public_token, userId, linkMetadata(req.body))
        res.json({ success: true, institutionName: result.institutionName })
      } catch (err: any) {
        if (err instanceof LinkRefused) {
          res.status(409).json({ error: err.message, code: err.code, itemId: err.itemId, institutionName: err.institutionName })
          return
        }
        console.error('❌ exchangeToken:', err.response?.data || err.message)
        res.status(500).json({ error: 'Failed to exchange token' })
      }
    },

    async sync(req: Request, res: Response) {
      try {
        const userId = getUserId(req)
        const { syncedItemIds, ...result } = await triggerSync(plaidClient, userId)
        // Then the streams of every Item that synced (M7.6 PR 5e): after the sync,
        // not alongside it, under the Plaid limiter like the sync, and skipped
        // within the cooldown. A failure is reported and never fails the sync.
        // The response waits for both, so the app's refetch on it sees fresh streams.
        let streams = { refreshed: 0, skipped: 0, failed: 0 }
        try {
          streams = await refreshAfterSync(plaidClient, userId, syncedItemIds)
        } catch (err) {
          Sentry.captureException(err)
        }
        res.json({ ...result, streams })
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
        historical_update_complete?: boolean
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
              // A new link's history is complete: its first recurring-streams
              // refresh runs AFTER this sync, so the streams' transactions are
              // already in our rows. firstRefreshIfNeeded fires only while the
              // Item has never been refreshed (Plaid keeps sending this flag).
              const historyComplete =
                webhook_code === 'SYNC_UPDATES_AVAILABLE' && req.body.historical_update_complete === true
              triggerSync(plaidClient, plaidItem.userId)
                .then(async () => {
                  if (historyComplete) await firstRefreshIfNeeded(plaidClient, plaidItem.id)
                })
                .catch((err: any) => {
                  Sentry.captureException(err)
                  console.error('❌ Webhook sync error:', err.message)
                })
            }
          }
        }

        // Plaid's recurring streams changed for this Item: refresh it, and
        // only it. Never throws; an unknown item id is a quiet no-op, and
        // failures go to Sentry inside the refresh.
        if (webhook_code === 'RECURRING_TRANSACTIONS_UPDATE' && item_id) {
          void refreshOnRecurringUpdate(plaidClient, item_id)
        }
      }

      // Consent withdrawn, for the whole Item or one of its accounts: recorded
      // with the Item's hash only, whether or not we still hold the Item.
      // Nothing else the handler does changes (USER_ACCOUNT_REVOKED has no
      // other handling).
      if (
        webhook_type === 'ITEM' && typeof item_id === 'string' && item_id &&
        (webhook_code === 'USER_PERMISSION_REVOKED' || webhook_code === 'USER_ACCOUNT_REVOKED')
      ) {
        await recordAudit({
          event: webhook_code === 'USER_PERMISSION_REVOKED' ? 'item.permission_revoked' : 'item.account_revoked',
          actor: 'plaid',
          itemId: item_id,
        })
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

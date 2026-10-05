import { PlaidApi, CountryCode, Products } from 'plaid'
import * as Sentry from '@sentry/node'
import prisma              from '../lib/prisma'
import { encrypt, decrypt } from '../utils/encrypt'
import { syncTransactions } from './plaidSync'
import { captureBalanceSnapshots } from './networth.service'
import { ensureUser } from './user.service'
import { removeItemAtPlaid, removePlaidItemRows } from './plaidItems.service'
import { classifyPlaidError } from '../utils/plaidErrors'

function sanitizeAccountName(name: string): string {
  // Plaid sends ® as a lone ISO-8859-1 byte (0xAE) inside a UTF-8 JSON response;
  // Node's JSON parser replaces each invalid byte with U+FFFD. Two consecutive
  // replacement chars = ® pattern; lone ones are stripped.
  return name.replace(/��/g, '®').replace(/�/g, '').trim()
}

/**
 * Days of transaction history a NEW link asks for. Plaid's default is 90;
 * Plaid recommends at least 180 for Recurring Transactions, which M7.6 stores.
 * It applies only when Transactions is first initialised on an Item ("once
 * Transactions has been added to an Item, this value cannot be updated"), so
 * existing Items keep what they had, and the update-mode token leaves it out.
 * Plaid's docs tie no pricing to it; more days make the first pull slower.
 */
export const LINK_HISTORY_DAYS = 180

export async function createLinkToken(
  plaidClient:   PlaidApi,
  products:      Products[],
  countryCodes:  CountryCode[],
  userId:        string
): Promise<string> {
  const response = await plaidClient.linkTokenCreate({
    user:          { client_user_id: userId },
    client_name:   'My Finance App',
    products,
    country_codes: countryCodes,
    language:      'en',
    webhook:       process.env.WEBHOOK_URL,
    transactions:  { days_requested: LINK_HISTORY_DAYS },
  })
  return response.data.link_token
}

// ── Linking: never a second Item for the same accounts ────────────
//
// An Item bills monthly from the moment its public token is exchanged, and
// removal isn't pro-rated, so the cheapest duplicate is the one never
// exchanged. Two checks, one rule:
//
//   BEFORE exchange, on Link's onSuccess metadata (from the browser, so a
//   cost and UX guard only): an overlapping account at the same institution
//   is refused (DUPLICATE_ITEM -> Reconnect); the same institution with no
//   overlap is ambiguous — a second login, or the same login with other
//   accounts — so the user is asked (SAME_INSTITUTION) unless they have
//   confirmed a different login.
//
//   AFTER exchange, on Plaid's own accounts (the real guarantee): an overlap
//   removes the NEW Item. The user's existing Item, and every tag, note,
//   override and mark on its rows, is never touched by a new link. (It used
//   to be: any new link at a known institution removed the old Item and
//   deleted its rows.)
//
// Store first: the new Item's row is written straight after the exchange,
// before anything else can fail, so no billed Item is ever invisible to us.
// If a later step fails, it is removed at Plaid and its row deleted; if that
// removal fails too, the row stays (unlink can still remove it) and the
// item_id — never the token — goes to Sentry, to report to Plaid by id.
//
// The overlap check and the write run under a per-user Postgres advisory
// lock, inside one transaction: two links finishing at once (two tabs, or two
// Railway instances during a deploy) are serialised, and the second sees the
// first's accounts.

/** An account as Link's metadata or Plaid's /accounts/get describes it. */
export interface LinkAccount {
  name: string | null
  mask: string | null
  subtype: string | null
}

const normName = (n: string | null) => (n ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * The same account: same subtype and same mask. Where neither has a mask,
 * the name decides. One masked and one not is not the same account.
 */
export function accountsOverlap(a: LinkAccount, b: LinkAccount): boolean {
  if ((a.subtype ?? null) !== (b.subtype ?? null)) return false
  if (a.mask && b.mask) return a.mask === b.mask
  if (!a.mask && !b.mask) return normName(a.name) !== '' && normName(a.name) === normName(b.name)
  return false
}

type ExistingItem = { id: string; institutionId: string | null; institutionName: string | null; accounts: LinkAccount[] }

type LinkVerdict =
  | { kind: 'new' }
  | { kind: 'duplicate'; item: ExistingItem }
  | { kind: 'same-institution'; item: ExistingItem }

/** How a link relates to the user's Items. A null institution id never matches. */
function judgeLink(institutionId: string | null, accounts: LinkAccount[], items: ExistingItem[]): LinkVerdict {
  if (!institutionId) return { kind: 'new' }
  const sameInstitution = items.filter((i) => i.institutionId === institutionId)
  const dup = sameInstitution.find((i) => i.accounts.some((a) => accounts.some((b) => accountsOverlap(a, b))))
  if (dup) return { kind: 'duplicate', item: dup }
  if (sameInstitution.length > 0) return { kind: 'same-institution', item: sameInstitution[0] }
  return { kind: 'new' }
}

/** A link the server won't complete, and why: the controller answers 409 with these. */
export class LinkRefused extends Error {
  constructor(
    public readonly code: 'DUPLICATE_ITEM' | 'SAME_INSTITUTION',
    public readonly itemId: string,
    public readonly institutionName: string | null,
  ) {
    super(code === 'DUPLICATE_ITEM'
      ? 'This bank is already connected. Reconnect it instead of linking it again.'
      : 'You already have this bank connected. Is this a different login?')
  }
}

export interface LinkMetadata {
  institutionId?: string | null
  accounts?: LinkAccount[]
  /** The user said this is a different login at a bank they already have. */
  confirmedNewLogin?: boolean
}

type ItemReader = { plaidItem: Pick<typeof prisma.plaidItem, 'findMany'> }

async function itemsOf(db: ItemReader, userId: string, excludeId?: string): Promise<ExistingItem[]> {
  return db.plaidItem.findMany({
    where: { userId, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true, institutionId: true, institutionName: true, accounts: { select: { name: true, mask: true, subtype: true } } },
  })
}

export async function exchangePublicToken(
  plaidClient:  PlaidApi,
  publicToken:  string,
  userId:       string,
  meta:         LinkMetadata = {},
): Promise<{ institutionName: string | null }> {
  // Clerk authenticates the user but never creates our User row: do that
  // first so the PlaidItem, Account and Transaction writes have a valid FK.
  await ensureUser(userId)

  // ── Before exchange: nothing is billed yet ──────────────────────────
  if (meta.institutionId) {
    const verdict = judgeLink(meta.institutionId, meta.accounts ?? [], await itemsOf(prisma, userId))
    if (verdict.kind === 'duplicate') {
      throw new LinkRefused('DUPLICATE_ITEM', verdict.item.id, verdict.item.institutionName)
    }
    if (verdict.kind === 'same-institution' && !meta.confirmedNewLogin) {
      throw new LinkRefused('SAME_INSTITUTION', verdict.item.id, verdict.item.institutionName)
    }
  }

  // ── Exchange: from here the Item exists at Plaid and bills ──────────
  const tokenResponse = await plaidClient.itemPublicTokenExchange({ public_token: publicToken })
  const { access_token, item_id } = tokenResponse.data
  const encryptedToken = encrypt(access_token)

  // Store first, before anything else can fail.
  let stored: { id: string } | null = null
  try {
    stored = await prisma.plaidItem.create({
      data: { userId, itemId: item_id, accessToken: encryptedToken, institutionId: null, institutionName: null },
      select: { id: true },
    })

    const itemResponse  = await plaidClient.itemGet({ access_token })
    const institutionId = itemResponse.data.item.institution_id ?? null

    let institutionName: string | null = null
    if (institutionId) {
      try {
        const instResponse = await plaidClient.institutionsGetById({
          institution_id: institutionId,
          country_codes:  ['US' as CountryCode],
        })
        institutionName = instResponse.data.institution.name
      } catch {
        // A display name only: the link stands without it.
      }
    }

    const accountsResponse = await plaidClient.accountsGet({ access_token })
    const plaidAccounts = accountsResponse.data.accounts

    // ── After exchange: the real check, serialised per user ───────────
    const newId = stored.id
    const duplicateOf = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('plaid-link'), hashtext(${userId}))`
      const verdict = judgeLink(
        institutionId,
        plaidAccounts.map((a) => ({ name: a.name, mask: a.mask ?? null, subtype: a.subtype ?? null })),
        await itemsOf(tx, userId, newId),
      )
      if (verdict.kind === 'duplicate') return verdict.item

      await tx.plaidItem.update({ where: { id: newId }, data: { institutionId, institutionName } })
      for (const acct of plaidAccounts) {
        const fields = {
          userId,
          plaidItemId:      newId,
          name:             sanitizeAccountName(acct.name),
          officialName:     acct.official_name ? sanitizeAccountName(acct.official_name) : null,
          type:             acct.type,
          subtype:          acct.subtype                    ?? null,
          mask:             acct.mask                       ?? null,
          currentBalance:   acct.balances.current,
          availableBalance: acct.balances.available,
          isoCurrencyCode:  acct.balances.iso_currency_code ?? null,
        }
        await tx.account.upsert({
          where:  { plaidAccountId: acct.account_id },
          update: fields,
          create: { ...fields, plaidAccountId: acct.account_id },
        })
      }
      return null
    })

    if (duplicateOf) {
      // The NEW Item goes; the user's existing one, and its rows, stay.
      await discardNewItem(plaidClient, newId, encryptedToken, item_id)
      throw new LinkRefused('DUPLICATE_ITEM', duplicateOf.id, duplicateOf.institutionName)
    }

    console.log(`✅ ${institutionName} connected — ${plaidAccounts.length} accounts`)
    return { institutionName }
  } catch (err) {
    if (err instanceof LinkRefused) throw err
    // Anything failed after the exchange: don't leave a billed Item behind.
    if (stored) await discardNewItem(plaidClient, stored.id, encryptedToken, item_id)
    else await removeOrReport(plaidClient, encryptedToken, item_id)
    throw err
  }
}

/** Remove a just-exchanged Item at Plaid, then its row. If Plaid refuses, keep the row and report the id. */
async function discardNewItem(plaidClient: PlaidApi, rowId: string, encryptedToken: string, itemId: string) {
  if (await removeOrReport(plaidClient, encryptedToken, itemId)) {
    // The same list of an Item's dependents unlink uses.
    await removePlaidItemRows(rowId)
  } else {
    await prisma.plaidItem.update({ where: { id: rowId }, data: { status: 'error', lastErrorAt: new Date() } })
  }
}

/** /item/remove; on failure, the item_id (never the token) to Sentry. True when removed. */
async function removeOrReport(plaidClient: PlaidApi, encryptedToken: string, itemId: string): Promise<boolean> {
  try {
    await removeItemAtPlaid(plaidClient, encryptedToken)
    return true
  } catch (removeErr: any) {
    Sentry.captureMessage('plaid.link: a just-exchanged Item could not be removed; report it to Plaid by item_id', {
      level: 'error',
      extra: { itemId, errorCode: removeErr?.response?.data?.error_code ?? null },
    })
    return false
  }
}

export async function createUpdateLinkToken(
  plaidClient:  PlaidApi,
  userId:       string,
  countryCodes: CountryCode[],
  itemId?:      string,
  options:      { accountSelection?: boolean } = {},
): Promise<string> {
  // Ownership check: an explicit itemId must belong to this user. With no itemId,
  // fall back to the user's oldest item — deterministic, but callers with more than
  // one linked institution should pass itemId to target a specific connection.
  const item = itemId
    ? await prisma.plaidItem.findFirst({ where: { id: itemId, userId } })
    : await prisma.plaidItem.findFirst({ where: { userId }, orderBy: { createdAt: 'asc' } })

  if (!item) throw new Error('PlaidItem not found')

  const accessToken = decrypt(item.accessToken)

  // Update mode: pass access_token, omit products.
  // Plaid re-authenticates the user against the institution, which resolves
  // ITEM_LOGIN_REQUIRED and similar errors on the Item.
  const response = await plaidClient.linkTokenCreate({
    user:          { client_user_id: userId },
    client_name:   'My Finance App',
    access_token:  accessToken,
    country_codes: countryCodes,
    language:      'en',
    webhook:       process.env.WEBHOOK_URL,
    // Lets the user add accounts to this Item instead of linking it again.
    ...(options.accountSelection ? { update: { account_selection_enabled: true } } : {}),
  })
  return response.data.link_token
}

export async function triggerSync(
  plaidClient: PlaidApi,
  userId: string
): Promise<{ added: number; modified: number; removed: number }> {
  const items = await prisma.plaidItem.findMany({
    where: { userId },
  })

  let added = 0, modified = 0, removed = 0
  for (const item of items) {
    // Isolate each item's sync — one broken connection must not abort the rest.
    try {
      const accessToken = decrypt(item.accessToken)
      // Balances come from /accounts/get only: Plaid's cached balance, as of the
      // Item's last successful update (about once a day with Transactions).
      // Real-time /accounts/balance/get is a separately authorised, paid
      // product this client doesn't have; every call returned INVALID_PRODUCT
      // and fell back to this anyway. See README, "Balances".
      const acctResp = await plaidClient.accountsGet({ access_token: accessToken })
      for (const acct of acctResp.data.accounts) {
        const fields = {
          name:             sanitizeAccountName(acct.name),
          officialName:     acct.official_name ? sanitizeAccountName(acct.official_name) : null,
          currentBalance:   acct.balances.current,
          availableBalance: acct.balances.available,
        }
        // Upsert, not update: an account the user added to this Item through
        // update mode's account selection appears here for the first time.
        await prisma.account.upsert({
          where:  { plaidAccountId: acct.account_id },
          update: fields,
          create: {
            ...fields,
            userId,
            plaidItemId:     item.id,
            plaidAccountId:  acct.account_id,
            type:            acct.type,
            subtype:         acct.subtype                    ?? null,
            mask:            acct.mask                       ?? null,
            isoCurrencyCode: acct.balances.iso_currency_code ?? null,
          },
        })
      }
      const result = await syncTransactions(plaidClient, item.id)
      added    += result.added
      modified += result.modified
      removed  += result.removed

      await prisma.plaidItem.update({
        where: { id: item.id },
        data:  { status: 'healthy', errorCode: null, lastErrorAt: null },
      })
    } catch (err: any) {
      const { status, errorCode } = classifyPlaidError(err)
      await prisma.plaidItem.update({
        where: { id: item.id },
        data:  { status, errorCode: errorCode ?? null, lastErrorAt: new Date() },
      })
      Sentry.captureException(err)
      console.error(`❌ [sync] item ${item.id} failed (status=${status}, code=${errorCode ?? 'n/a'}):`, err.message)
    }
  }

  // Belt-and-suspenders: write a snapshot after ALL items are synced so
  // the chart gets a point even when individual item syncs partially fail.
  try {
    const snap = await captureBalanceSnapshots(userId)
    console.log(`📸 [sync] net-worth snapshot: ${snap.captured} account(s) for user ${userId}`)
  } catch (snapErr: any) {
    console.warn(`⚠️  [sync] final snapshot failed for user ${userId}:`, snapErr.message)
  }

  return { added, modified, removed }
}

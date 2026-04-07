import { PlaidApi, CountryCode, Products } from 'plaid'
import prisma              from '../lib/prisma'
import { encrypt, decrypt } from '../utils/encrypt'
import { syncTransactions } from './plaidSync'

const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID!

export async function createLinkToken(
  plaidClient:   PlaidApi,
  products:      Products[],
  countryCodes:  CountryCode[],
  userId?:       string
): Promise<string> {
  const response = await plaidClient.linkTokenCreate({
    user:          { client_user_id: userId || DEFAULT_USER_ID },
    client_name:   'My Finance App',
    products,
    country_codes: countryCodes,
    language:      'en',
    webhook:       process.env.WEBHOOK_URL,
  })
  return response.data.link_token
}

export async function exchangePublicToken(
  plaidClient:  PlaidApi,
  publicToken:  string
): Promise<{ institutionName: string | null }> {
  // 1. Exchange for permanent access token
  const tokenResponse = await plaidClient.itemPublicTokenExchange({ public_token: publicToken })
  const { access_token, item_id } = tokenResponse.data

  // 2. Encrypt before storing
  const encryptedToken = encrypt(access_token)

  // 3. Get institution details
  const itemResponse  = await plaidClient.itemGet({ access_token })
  const institutionId = itemResponse.data.item.institution_id

  let institutionName: string | null = null
  if (institutionId) {
    const instResponse = await plaidClient.institutionsGetById({
      institution_id: institutionId,
      country_codes:  ['US' as CountryCode],
    })
    institutionName = instResponse.data.institution.name
  }

  // 4. Re-link: if item exists for this institution, replace it cleanly
  const existingItem = await prisma.plaidItem.findFirst({
    where: { userId: DEFAULT_USER_ID, institutionId },
  })

  if (existingItem) {
    console.log(`🔄 Re-linking ${institutionName} — replacing existing item`)

    const existingAccounts = await prisma.account.findMany({
      where:  { plaidItemId: existingItem.id },
      select: { id: true },
    })
    const accountIds = existingAccounts.map((a: { id: string }) => a.id)

    await prisma.transaction.deleteMany({ where: { accountId: { in: accountIds } } })
    await prisma.account.deleteMany({ where: { plaidItemId: existingItem.id } })
    await prisma.plaidItem.delete({ where: { id: existingItem.id } })

    console.log(`🗑  Removed old item + ${accountIds.length} accounts`)
  }

  // 5. Create fresh PlaidItem
  const plaidItem = await prisma.plaidItem.create({
    data: {
      userId:          DEFAULT_USER_ID,
      itemId:          item_id,
      accessToken:     encryptedToken,
      institutionId,
      institutionName,
    },
  })

  // 6. Fetch and persist accounts
  const accountsResponse = await plaidClient.accountsGet({ access_token })

  for (const acct of accountsResponse.data.accounts) {
    await prisma.account.upsert({
      where:  { plaidAccountId: acct.account_id },
      update: {
        userId:           DEFAULT_USER_ID,
        plaidItemId:      plaidItem.id,
        name:             acct.name,
        officialName:     acct.official_name              ?? null,
        type:             acct.type,
        subtype:          acct.subtype                    ?? null,
        mask:             acct.mask                       ?? null,
        currentBalance:   acct.balances.current,
        availableBalance: acct.balances.available,
        isoCurrencyCode:  acct.balances.iso_currency_code ?? null,
      },
      create: {
        userId:           DEFAULT_USER_ID,
        plaidItemId:      plaidItem.id,
        plaidAccountId:   acct.account_id,
        name:             acct.name,
        officialName:     acct.official_name              ?? null,
        type:             acct.type,
        subtype:          acct.subtype                    ?? null,
        mask:             acct.mask                       ?? null,
        currentBalance:   acct.balances.current,
        availableBalance: acct.balances.available,
        isoCurrencyCode:  acct.balances.iso_currency_code ?? null,
      },
    })
  }

  console.log(`✅ ${institutionName} connected — ${accountsResponse.data.accounts.length} accounts`)
  return { institutionName }
}

export async function triggerSync(
  plaidClient: PlaidApi
): Promise<{ added: number; modified: number; removed: number }> {
  const items = await prisma.plaidItem.findMany({
    where: { userId: DEFAULT_USER_ID },
  })

  let added = 0, modified = 0, removed = 0
  for (const item of items) {
    const result = await syncTransactions(plaidClient, item.id)
    added    += result.added
    modified += result.modified
    removed  += result.removed
  }

  return { added, modified, removed }
}
import { PlaidApi, CountryCode, Products } from 'plaid'
import prisma              from '../lib/prisma'
import { encrypt, decrypt } from '../utils/encrypt'
import { syncTransactions } from './plaidSync'

function sanitizeAccountName(name: string): string {
  // Plaid sends ® as a lone ISO-8859-1 byte (0xAE) inside a UTF-8 JSON response;
  // Node's JSON parser replaces each invalid byte with U+FFFD. Two consecutive
  // replacement chars = ® pattern; lone ones are stripped.
  return name.replace(/��/g, '®').replace(/�/g, '').trim()
}

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
  })
  return response.data.link_token
}

export async function exchangePublicToken(
  plaidClient:  PlaidApi,
  publicToken:  string,
  userId:       string
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
    where: { userId, institutionId },
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
      userId,
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
        userId,
        plaidItemId:      plaidItem.id,
        name:             sanitizeAccountName(acct.name),
        officialName:     acct.official_name ? sanitizeAccountName(acct.official_name) : null,
        type:             acct.type,
        subtype:          acct.subtype                    ?? null,
        mask:             acct.mask                       ?? null,
        currentBalance:   acct.balances.current,
        availableBalance: acct.balances.available,
        isoCurrencyCode:  acct.balances.iso_currency_code ?? null,
      },
      create: {
        userId,
        plaidItemId:      plaidItem.id,
        plaidAccountId:   acct.account_id,
        name:             sanitizeAccountName(acct.name),
        officialName:     acct.official_name ? sanitizeAccountName(acct.official_name) : null,
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

export async function createUpdateLinkToken(
  plaidClient:  PlaidApi,
  userId:       string,
  countryCodes: CountryCode[]
): Promise<string> {
  const item = await prisma.plaidItem.findFirst({ where: { userId } })
  if (!item) throw new Error('No linked account found for this user')

  const accessToken = decrypt(item.accessToken)

  // Update mode: pass access_token, omit products.
  // Plaid re-authenticates the user against the institution which resolves
  // ITEM_LOGIN_REQUIRED errors and refreshes the item so balance/get succeeds.
  const response = await plaidClient.linkTokenCreate({
    user:          { client_user_id: userId },
    client_name:   'My Finance App',
    access_token:  accessToken,
    country_codes: countryCodes,
    language:      'en',
    webhook:       process.env.WEBHOOK_URL,
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
    const accessToken = decrypt(item.accessToken)
    let acctResp: Awaited<ReturnType<typeof plaidClient.accountsBalanceGet>>
    try {
      acctResp = await plaidClient.accountsBalanceGet({ access_token: accessToken })
      console.log(`💰 [sync] balance/get succeeded for item ${item.id}`)
    } catch (balErr: any) {
      const code = balErr.response?.data?.error_code ?? balErr.message
      console.warn(`⚠️  [sync] balance/get failed (${code}) — falling back to accounts/get for item ${item.id}`)
      acctResp = await plaidClient.accountsGet({ access_token: accessToken })
    }
    for (const acct of acctResp.data.accounts) {
      await prisma.account.updateMany({
        where: { plaidAccountId: acct.account_id },
        data: {
          name:             sanitizeAccountName(acct.name),
          officialName:     acct.official_name ? sanitizeAccountName(acct.official_name) : null,
          currentBalance:   acct.balances.current,
          availableBalance: acct.balances.available,
        },
      })
    }
    const result = await syncTransactions(plaidClient, item.id)
    added    += result.added
    modified += result.modified
    removed  += result.removed
  }

  return { added, modified, removed }
}

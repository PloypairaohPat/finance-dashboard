import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid'

const plaidEnv = process.env.PLAID_ENV! as keyof typeof PlaidEnvironments

export const plaidClient = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments[plaidEnv],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID!,
      'PLAID-SECRET': process.env.PLAID_SECRET!,
    },
  },
}))
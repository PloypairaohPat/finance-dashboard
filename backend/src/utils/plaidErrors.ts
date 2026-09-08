export type PlaidItemStatus = 'login_required' | 'pending_expiration' | 'revoked' | 'error'

export interface ClassifiedPlaidError {
  status: PlaidItemStatus
  errorCode: string | undefined
}

const LOGIN_REQUIRED_CODES = new Set(['ITEM_LOGIN_REQUIRED', 'INVALID_CREDENTIALS', 'INVALID_MFA'])
const REVOKED_CODES = new Set(['USER_PERMISSION_REVOKED', 'ITEM_NOT_FOUND'])

// Maps a caught Plaid API error (or a webhook's error payload) to a PlaidItem status.
export function classifyPlaidError(err: any): ClassifiedPlaidError {
  const errorCode: string | undefined = err?.response?.data?.error_code ?? err?.error_code

  if (errorCode && LOGIN_REQUIRED_CODES.has(errorCode)) {
    return { status: 'login_required', errorCode }
  }
  if (errorCode && REVOKED_CODES.has(errorCode)) {
    return { status: 'revoked', errorCode }
  }
  return { status: 'error', errorCode }
}

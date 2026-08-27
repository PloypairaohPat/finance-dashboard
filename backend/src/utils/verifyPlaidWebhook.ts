import crypto from 'crypto'
import { PlaidApi, JWKPublicKey } from 'plaid'
import { importJWK, jwtVerify, decodeProtectedHeader } from 'jose'

const MAX_TOKEN_AGE_SECONDS = 5 * 60

const keyCache = new Map<string, JWKPublicKey>()

async function getVerificationKey(plaidClient: PlaidApi, kid: string): Promise<JWKPublicKey> {
  const cached = keyCache.get(kid)
  if (cached) return cached

  const response = await plaidClient.webhookVerificationKeyGet({ key_id: kid })
  const key = response.data.key
  keyCache.set(kid, key)
  return key
}

export async function verifyPlaidWebhook(
  plaidClient: PlaidApi,
  verificationHeader: string | undefined,
  rawBody: Buffer
): Promise<boolean> {
  try {
    if (!verificationHeader) return false

    const { kid, alg } = decodeProtectedHeader(verificationHeader)
    if (alg !== 'ES256' || !kid) return false

    const jwk = await getVerificationKey(plaidClient, kid)
    const key = await importJWK({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, 'ES256')

    const { payload } = await jwtVerify(verificationHeader, key)

    const iat = payload.iat
    if (typeof iat !== 'number') return false
    const ageSeconds = Date.now() / 1000 - iat
    if (ageSeconds > MAX_TOKEN_AGE_SECONDS) return false

    const claimedHash = payload.request_body_sha256
    if (typeof claimedHash !== 'string') return false

    const actualHash = crypto.createHash('sha256').update(rawBody).digest('hex')

    const claimedBuf = Buffer.from(claimedHash, 'hex')
    const actualBuf  = Buffer.from(actualHash, 'hex')
    if (claimedBuf.length !== actualBuf.length) return false
    if (!crypto.timingSafeEqual(claimedBuf, actualBuf)) return false

    return true
  } catch {
    return false
  }
}

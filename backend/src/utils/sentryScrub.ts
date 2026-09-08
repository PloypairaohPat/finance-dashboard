// This app handles bank data (Plaid access tokens, encryption keys, Clerk sessions).
// Sentry must never receive any of it. sendDefaultPii:false already limits some default
// collection, but we scrub explicitly rather than trust SDK defaults to keep doing so.

const REDACTED = '[Filtered]'

// Headers that must never leave this process, regardless of casing.
const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'x-demo-mode', 'plaid-verification'])

// Plaid access tokens, e.g. "access-sandbox-<uuid>" / "access-production-<uuid>".
const ACCESS_TOKEN_PATTERN = /\baccess-(?:sandbox|development|production)-[a-f0-9-]+\b/gi

// JWTs (Clerk session tokens, Plaid webhook verification JWTs): three dot-separated segments.
const JWT_PATTERN = /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g

// Our own encrypt.ts stores tokens as "iv:tag:ciphertext", all hex.
const ENCRYPTED_PAYLOAD_PATTERN = /\b[0-9a-fA-F]{16,}:[0-9a-fA-F]{16,}:[0-9a-fA-F]{16,}\b/g

// Bare hex keys/secrets, e.g. ENCRYPTION_KEY (64 hex chars) or any standalone hex blob.
const HEX_KEY_PATTERN = /\b[0-9a-fA-F]{32,}\b/g

function scrubString(value: string): string {
  return value
    .replace(ENCRYPTED_PAYLOAD_PATTERN, REDACTED)
    .replace(ACCESS_TOKEN_PATTERN, REDACTED)
    .replace(JWT_PATTERN, REDACTED)
    .replace(HEX_KEY_PATTERN, REDACTED)
}

function scrubValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return scrubString(value)
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, seen))
  if (value && typeof value === 'object') {
    if (seen.has(value as object)) return value
    seen.add(value as object)
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubValue(v, seen)
    }
    return out
  }
  return value
}

// beforeSend hook: strips request bodies/cookies/sensitive headers outright, then
// deep-scrubs whatever remains (message, extra, contexts, breadcrumbs, stack frames)
// for anything shaped like a token, JWT, or hex key that might have leaked in elsewhere.
export function scrubSentryEvent<T extends Record<string, any>>(event: T): T {
  if (event.request) {
    delete event.request.data
    delete event.request.cookies
    if (event.request.headers) {
      for (const key of Object.keys(event.request.headers)) {
        if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
          delete event.request.headers[key]
        }
      }
    }
  }
  return scrubValue(event, new WeakSet()) as T
}

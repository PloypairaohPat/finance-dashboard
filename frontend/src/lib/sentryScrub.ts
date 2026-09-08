// This app handles bank data. Sentry must never receive access tokens, session
// tokens, or auth headers from the frontend either. sendDefaultPii:false already
// limits some default collection, but we scrub explicitly rather than trust SDK
// defaults to keep doing so — mirrors backend/src/utils/sentryScrub.ts.

const REDACTED = '[Filtered]'

const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'x-demo-mode', 'plaid-verification'])

// JWTs (Clerk session tokens): three dot-separated segments.
const JWT_PATTERN = /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g

// Bare hex keys/secrets/tokens.
const HEX_KEY_PATTERN = /\b[0-9a-fA-F]{32,}\b/g

function scrubString(value: string): string {
  return value.replace(JWT_PATTERN, REDACTED).replace(HEX_KEY_PATTERN, REDACTED)
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
  if (Array.isArray(event.breadcrumbs)) {
    for (const crumb of event.breadcrumbs) {
      if (crumb?.data) {
        delete crumb.data.body
        delete crumb.data.request_body
        if (crumb.data.headers) {
          for (const key of Object.keys(crumb.data.headers)) {
            if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
              delete crumb.data.headers[key]
            }
          }
        }
      }
    }
  }
  return scrubValue(event, new WeakSet()) as T
}

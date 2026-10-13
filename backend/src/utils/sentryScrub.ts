// This app handles bank data (Plaid access tokens, encryption keys, Clerk sessions).
// Sentry must never receive any of it. sendDefaultPii:false already limits some default
// collection, but we scrub explicitly rather than trust SDK defaults to keep doing so.
//
// Three layers, each catching what the others miss:
//   1. known places are removed outright: request bodies, cookies, sensitive headers,
//      the query string, breadcrumb bodies;
//   2. anything under a secret-ish key (secret, password, client_id, *_token…) is
//      filtered whatever its shape: a Plaid secret is 30 hex characters, which the
//      hex pattern below doesn't match;
//   3. every remaining string is scrubbed for token-, key- and URL-query-shaped text.
// Mirrored in frontend/src/lib/sentryScrub.ts.

const REDACTED = '[Filtered]'

// Headers that must never leave this process, regardless of casing.
const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'x-demo-mode', 'plaid-verification'])

// Keys whose values are filtered whatever they hold. `query_string` and `http.query`
// are where Sentry keeps a URL's query apart from the URL itself.
const SENSITIVE_KEY =
  /secret|passw(?:or)?d|(?:^|[_-])(?:access|refresh|id|session|link|public)[_-]?token$|api[_-]?key|^client[_-]?id$|^authorization$|cookie|^query_string$|^http\.(?:query|fragment)$/i

// Plaid access tokens, e.g. "access-sandbox-<uuid>" / "access-production-<uuid>".
const ACCESS_TOKEN_PATTERN = /\baccess-(?:sandbox|development|production)-[a-f0-9-]+\b/gi

// JWTs (Clerk session tokens, Plaid webhook verification JWTs): three dot-separated segments.
const JWT_PATTERN = /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g

// Our own encrypt.ts stores tokens as "iv:tag:ciphertext", all hex.
const ENCRYPTED_PAYLOAD_PATTERN = /\b[0-9a-fA-F]{16,}:[0-9a-fA-F]{16,}:[0-9a-fA-F]{16,}\b/g

// Bare hex keys/secrets, e.g. ENCRYPTION_KEY (64 hex chars) or any standalone hex blob.
const HEX_KEY_PATTERN = /\b[0-9a-fA-F]{32,}\b/g

// A URL's query string or fragment, absolute ("https://…/x?q=…") or a path ("/x?q=…").
// What someone searched for or filtered on (?q=coffee&minAmount=50) travels there.
const URL_QUERY_PATTERN = /((?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s?#"'<>]*)[?#][^\s"'<>]*/gi

function scrubString(value: string): string {
  return value
    .replace(ENCRYPTED_PAYLOAD_PATTERN, REDACTED)
    .replace(ACCESS_TOKEN_PATTERN, REDACTED)
    .replace(JWT_PATTERN, REDACTED)
    .replace(HEX_KEY_PATTERN, REDACTED)
    .replace(URL_QUERY_PATTERN, `$1?${REDACTED}`)
}

function scrubValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return scrubString(value)
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, seen))
  if (value && typeof value === 'object') {
    if (seen.has(value as object)) return value
    seen.add(value as object)
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) && v != null ? REDACTED : scrubValue(v, seen)
    }
    return out
  }
  return value
}

function stripHeaders(headers: Record<string, unknown> | undefined): void {
  if (!headers) return
  for (const key of Object.keys(headers)) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) delete headers[key]
  }
}

// beforeSend hook: strips request bodies/cookies/sensitive headers/query strings and
// breadcrumb bodies outright, then deep-scrubs whatever remains (message, extra,
// contexts, breadcrumbs, stack frames).
export function scrubSentryEvent<T extends Record<string, any>>(event: T): T {
  if (event.request) {
    delete event.request.data
    delete event.request.cookies
    delete event.request.query_string
    stripHeaders(event.request.headers)
  }
  if (Array.isArray(event.breadcrumbs)) {
    for (const crumb of event.breadcrumbs) {
      if (crumb?.data) {
        delete crumb.data.body
        delete crumb.data.request_body
        stripHeaders(crumb.data.headers)
      }
    }
  }
  return scrubValue(event, new WeakSet()) as T
}

// beforeBreadcrumb hook. Sentry's Node SDK turns console output into breadcrumbs and
// attaches the latest ones to every error. Our logs name users and banks, which
// Sentry doesn't need; Railway's logs keep them.
export function dropConsoleBreadcrumb<T extends { category?: string }>(breadcrumb: T): T | null {
  return breadcrumb.category === 'console' ? null : breadcrumb
}

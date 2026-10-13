// This app handles bank data. Sentry must never receive access tokens, session
// tokens, or auth headers from the frontend either. sendDefaultPii:false already
// limits some default collection, but we scrub explicitly rather than trust SDK
// defaults to keep doing so — mirrors backend/src/utils/sentryScrub.ts.
//
// Three layers: known places removed outright (request bodies, cookies, sensitive
// headers, the query string, breadcrumb bodies); values under secret-ish keys
// filtered whatever their shape; every remaining string scrubbed for token-, key-
// and URL-query-shaped text. The query matters here: the Transactions page keeps
// what someone searched for in the URL (?q=coffee&category=…), and Sentry records
// page and fetch URLs in breadcrumbs and on every event.

const REDACTED = '[Filtered]'

const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'x-demo-mode', 'plaid-verification'])

// Keys whose values are filtered whatever they hold. `query_string` and `http.query`
// are where Sentry keeps a URL's query apart from the URL itself.
const SENSITIVE_KEY =
  /secret|passw(?:or)?d|(?:^|[_-])(?:access|refresh|id|session|link|public)[_-]?token$|api[_-]?key|^client[_-]?id$|^authorization$|cookie|^query_string$|^http\.(?:query|fragment)$/i

// JWTs (Clerk session tokens): three dot-separated segments.
const JWT_PATTERN = /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g

// Bare hex keys/secrets/tokens.
const HEX_KEY_PATTERN = /\b[0-9a-fA-F]{32,}\b/g

// A URL's query string or fragment, absolute ("https://…/x?q=…") or a path ("/x?q=…").
const URL_QUERY_PATTERN = /((?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s?#"'<>]*)[?#][^\s"'<>]*/gi

function scrubString(value: string): string {
  return value
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

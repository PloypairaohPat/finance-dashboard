// What reaches Sentry from the backend (utils/sentryScrub.ts). No database: these are
// plain objects shaped like the events and breadcrumbs the Node SDK builds.

import { describe, expect, it } from 'vitest'
import { dropConsoleBreadcrumb, scrubSentryEvent } from '../src/utils/sentryScrub'

const API = 'https://api.example.invalid'

function serialized(event: Record<string, any>): string {
  return JSON.stringify(scrubSentryEvent(event))
}

describe('scrubSentryEvent: the request', () => {
  it('drops the body, cookies, query string and sensitive headers', () => {
    const out = scrubSentryEvent({
      request: {
        url: `${API}/transactions/search?q=coffee&minAmount=50`,
        query_string: 'q=coffee&minAmount=50',
        data: { note: 'a body' },
        cookies: { session: 'x' },
        headers: { Authorization: 'Bearer x', 'X-Demo-Mode': '1', 'User-Agent': 'test' },
      },
    })
    expect(out.request.url).toBe(`${API}/transactions/search?[Filtered]`)
    expect(out.request).not.toHaveProperty('query_string')
    expect(out.request).not.toHaveProperty('data')
    expect(out.request).not.toHaveProperty('cookies')
    expect(out.request.headers).toEqual({ 'User-Agent': 'test' })
  })

  it("strips the query from a header that carries a URL, such as the referer", () => {
    const out = scrubSentryEvent({
      request: { headers: { referer: 'https://app.example.invalid/transactions?q=rent&category=Housing' } },
    })
    expect(out.request.headers.referer).toBe('https://app.example.invalid/transactions?[Filtered]')
  })
})

describe('scrubSentryEvent: breadcrumbs', () => {
  it('strips queries from breadcrumb URLs and drops bodies and query fields', () => {
    const text = serialized({
      breadcrumbs: [
        { category: 'http', data: { url: `${API}/transactions/search?q=coffee`, method: 'GET', body: 'x' } },
        { category: 'http', data: { url: `${API}/transactions/search`, 'http.query': '?q=coffee', 'http.fragment': '#top' } },
        { category: 'navigation', data: { from: '/transactions?q=rent', to: '/budgets?demo=1' } },
      ],
    })
    expect(text).not.toMatch(/coffee|rent|demo=1|#top/)
    expect(text).not.toContain('"body"')
    expect(text).toContain('/transactions/search?[Filtered]')
  })

  it('drops console breadcrumbs and keeps the rest', () => {
    const http = { category: 'http', data: { url: `${API}/health` } }
    expect(dropConsoleBreadcrumb({ category: 'console', message: 'Synced a user' })).toBeNull()
    expect(dropConsoleBreadcrumb(http)).toBe(http)
  })
})

describe('scrubSentryEvent: values under secret-ish keys', () => {
  it('filters them whatever their shape, at any depth', () => {
    // 30 hex characters, the shape of a Plaid secret: too short for the hex-key rule.
    const plaidShapedSecret = 'abcdef0123456789abcdef01234567'
    const out = scrubSentryEvent({
      extra: {
        secret: plaidShapedSecret,
        PLAID_SECRET: plaidShapedSecret,
        client_id: 'abcdef0123456789abcdef01',
        clientId: 'abcdef0123456789abcdef01',
        password: 'hunter2',
        nested: { access_token: 'a', accessToken: 'b', link_token: 'c', public_token: 'd', apiKey: 'e' },
        // Operational context we keep on purpose.
        itemId: 'item-FAKE-1',
        during: 'recurring streams refresh',
        maxTokens: 3,
      },
    })
    expect(JSON.stringify(out)).not.toContain(plaidShapedSecret)
    expect(out.extra).toMatchObject({
      secret: '[Filtered]',
      PLAID_SECRET: '[Filtered]',
      client_id: '[Filtered]',
      clientId: '[Filtered]',
      password: '[Filtered]',
      nested: {
        access_token: '[Filtered]',
        accessToken: '[Filtered]',
        link_token: '[Filtered]',
        public_token: '[Filtered]',
        apiKey: '[Filtered]',
      },
      itemId: 'item-FAKE-1',
      during: 'recurring streams refresh',
      maxTokens: 3,
    })
  })
})

describe('scrubSentryEvent: strings anywhere', () => {
  it('still scrubs token- and key-shaped text', () => {
    const hex64 = 'ab'.repeat(32)
    const text = serialized({
      message: [
        'access-production-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJlLXZhbHVl',
        `${'0'.repeat(24)}:${'1'.repeat(32)}:${'2'.repeat(40)}`,
        hex64,
      ].join(' '),
    })
    expect(text).not.toMatch(/access-production-|eyJhbGci|0{24}:|abababab/)
  })

  it('strips a path query inside a message', () => {
    const out = scrubSentryEvent({ message: 'GET /transactions/search?q=coffee&tags=gift failed' })
    expect(out.message).toBe('GET /transactions/search?[Filtered] failed')
  })

  it('leaves ordinary text with question marks and slashes alone', () => {
    const message = 'Why did 4/5 retries fail? Ask the and/or rule.'
    expect(scrubSentryEvent({ message }).message).toBe(message)
  })
})

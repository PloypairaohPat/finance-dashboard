// What reaches Sentry from the browser (sentryScrub.ts): plain objects shaped like
// the events and breadcrumbs the React SDK builds.

import { describe, expect, it } from '@jest/globals'
import { scrubSentryEvent } from './sentryScrub'

const APP = 'https://app.example.invalid'
const API = 'https://api.example.invalid'

describe('scrubSentryEvent', () => {
  it("strips the page URL's query, where the Transactions filters live", () => {
    const out = scrubSentryEvent<Record<string, any>>({
      request: {
        url: `${APP}/transactions?q=coffee&category=Food&dateFrom=x&demo=1`,
        query_string: 'q=coffee',
        headers: { Referer: `${APP}/budgets?q=rent`, 'User-Agent': 'test' },
      },
    })
    expect(out.request.url).toBe(`${APP}/transactions?[Filtered]`)
    expect(out.request).not.toHaveProperty('query_string')
    expect(out.request.headers).toEqual({ Referer: `${APP}/budgets?[Filtered]`, 'User-Agent': 'test' })
  })

  it('strips queries from navigation and fetch breadcrumbs, and drops bodies and auth headers', () => {
    const out = scrubSentryEvent<Record<string, any>>({
      breadcrumbs: [
        { category: 'navigation', data: { from: '/transactions?q=rent', to: '/transactions?q=coffee&tags=gift' } },
        {
          category: 'fetch',
          data: {
            url: `${API}/transactions/search?q=coffee&minAmount=5&maxAmount=9`,
            method: 'GET',
            body: 'x',
            headers: { Authorization: 'Bearer x', 'X-Demo-Mode': '1' },
          },
        },
        { category: 'fetch', data: { url: `${API}/transactions/search`, 'http.query': '?q=coffee' } },
        { category: 'console', message: `Sync failed: GET ${API}/transactions/search?q=coffee` },
      ],
    })
    const text = JSON.stringify(out)
    expect(text).not.toMatch(/coffee|rent|gift|minAmount|Bearer|X-Demo-Mode|"body"/)
    expect(out.breadcrumbs[0].data).toEqual({ from: '/transactions?[Filtered]', to: '/transactions?[Filtered]' })
    expect(out.breadcrumbs[1].data.url).toBe(`${API}/transactions/search?[Filtered]`)
  })

  it('filters values under secret-ish keys whatever their shape', () => {
    const out = scrubSentryEvent<Record<string, any>>({
      extra: { link_token: 'link-sandbox-abc', publicToken: 'public-sandbox-abc', password: 'x', apiKey: 'y', count: 3 },
    })
    expect(out.extra).toEqual({
      link_token: '[Filtered]',
      publicToken: '[Filtered]',
      password: '[Filtered]',
      apiKey: '[Filtered]',
      count: 3,
    })
  })

  it('still scrubs JWTs and hex keys, and leaves ordinary text alone', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJlLXZhbHVl'
    const out = scrubSentryEvent<Record<string, any>>({ message: `token ${jwt} key ${'cd'.repeat(32)}` })
    expect(out.message).toBe('token [Filtered] key [Filtered]')
    const plain = 'Why did 4/5 retries fail? Ask the and/or rule.'
    expect(scrubSentryEvent<Record<string, any>>({ message: plain }).message).toBe(plain)
  })
})

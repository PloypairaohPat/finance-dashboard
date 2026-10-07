// ─────────────────────────────────────────────────────────────────
//  GET /health: its shape, the running commit, and that it stays
//  unauthenticated and outside the general rate limit.
// ─────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { app } from '../src/app'
import { runningCommit } from '../src/lib/runningCommit'

const saved = process.env.RAILWAY_GIT_COMMIT_SHA
afterEach(() => {
  if (saved === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA
  else process.env.RAILWAY_GIT_COMMIT_SHA = saved
})

describe('GET /health', () => {
  it('answers without auth, with exactly these fields, and the short commit Railway set', async () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567'
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    expect(Object.keys(res.body).sort()).toEqual(['commit', 'db', 'lastSync', 'lastSyncAgeHours', 'status'])
    expect(res.body).toMatchObject({ status: 'ok', db: 'ok', commit: '0123456' })
    // The test auth stub lets everything through, so check the route itself has no auth.
    expect(readFileSync(path.resolve(__dirname, '..', 'src', 'app.ts'), 'utf8')).toMatch(/^app\.get\('\/health', async \(/m)
  })

  it('says "unknown" when no commit is set', async () => {
    delete process.env.RAILWAY_GIT_COMMIT_SHA
    expect((await request(app).get('/health')).body.commit).toBe('unknown')
  })

  it('stays outside the general rate limit (150 per window)', async () => {
    for (let i = 0; i < 160; i++) {
      const res = await request(app).get('/health')
      expect(res.status, `request ${i + 1}`).toBe(200)
      expect(res.headers['ratelimit']).toBeUndefined()
    }
    // A route under the limit carries its headers, so the check above means something.
    expect((await request(app).get('/categories')).headers['ratelimit']).toBeDefined()
  }, 120_000)
})

describe('runningCommit', () => {
  it('shortens a sha, and never echoes anything that isn\u2019t one', () => {
    expect(runningCommit('ABCDEF0123456789abcdef0123456789abcdef01')).toBe('abcdef0')
    expect(runningCommit('abc1234')).toBe('abc1234')
    expect(runningCommit(undefined)).toBe('unknown')
    expect(runningCommit('')).toBe('unknown')
    expect(runningCommit('abc')).toBe('unknown')
    expect(runningCommit('<script>alert(1)</script>')).toBe('unknown')
  })
})

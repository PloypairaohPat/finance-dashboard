// ─────────────────────────────────────────────────────────────────
//  tests/non-demo-baseline.test.ts — the check that makes a demo reseed safe
//
//  The demo seed rebuilds rows in a database that also holds real users. It
//  fingerprints every non-demo row before and after, inside its transaction,
//  and rolls back on any difference. These pin the comparison, and that the
//  check covers every table that can hold a user's rows.
// ─────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { NON_DEMO_TABLES, diffBaselines, type BaselineEntry } from '../scripts/lib/non-demo-baseline'

const e = (table: string, user: string, rows: number, idHash = `h-${table}-${user}-${rows}`): BaselineEntry =>
  ({ table, user, rows, idHash })

describe('diffBaselines', () => {
  const before = [e('Transaction', 'user_a', 120), e('Account', 'user_a', 3), e('Transaction', 'user_b', 40)]

  it('is empty when nothing changed', () => {
    expect(diffBaselines(before, before.map((x) => ({ ...x })))).toEqual([])
  })

  it('catches a user whose rows all vanished — the unscoped deleteMany', () => {
    const after = before.filter((x) => x.user !== 'user_b')
    expect(diffBaselines(before, after)).toEqual([expect.stringMatching(/Transaction: all 40 row\(s\) of user user_b/)])
  })

  it('catches a partial delete', () => {
    const after = [e('Transaction', 'user_a', 119), before[1], before[2]]
    expect(diffBaselines(before, after)[0]).toMatch(/had 120 row\(s\), now 119/)
  })

  it('catches a delete-and-replace that keeps the count', () => {
    const after = [{ ...before[0], idHash: 'different' }, before[1], before[2]]
    expect(diffBaselines(before, after)[0]).toMatch(/same count but different rows/)
  })

  it('catches rows appearing under a user who had none in that table', () => {
    const after = [...before, e('Goal', 'user_b', 2)]
    expect(diffBaselines(before, after)[0]).toMatch(/Goal: 2 new row\(s\) under user user_b/)
  })

  it('never prints a whole user id', () => {
    const long = 'user_2FAKEab12CDef34GHij56KLmn78'
    const [msg] = diffBaselines([e('Budget', long, 5)], [])
    expect(msg).not.toContain(long)
  })
})

describe('NON_DEMO_TABLES', () => {
  it('covers every model in the schema that belongs to a user', () => {
    const schema = readFileSync(path.resolve(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8')
    const owned = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)]
      .filter(([, , body]) => /^\s+userId\s+String\b/m.test(body))
      .map(([, name]) => name)
    const covered = NON_DEMO_TABLES.map(([t]) => t)
    // If this fails, a table was added that the demo seed's safety check can't see.
    expect(covered.filter((t) => t !== 'User').sort()).toEqual(owned.sort())
    expect(covered).toContain('User')
  })
})

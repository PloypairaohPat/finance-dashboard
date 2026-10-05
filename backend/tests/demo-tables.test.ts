// ─────────────────────────────────────────────────────────────────
//  The demo reseed wipes every table that carries a user, children before
//  parents. A new table missing from WIPE_ORDER would leave the demo's old
//  rows behind, or — under a restrict foreign key — fail the reseed only once
//  the demo has rows in it. This catches it as soon as the table exists.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest'
import { WIPE_ORDER } from '../prisma/demo-tables'
import { NON_DEMO_TABLES } from '../src/lib/userFingerprint'

const asTable = (delegate: string) => delegate[0].toUpperCase() + delegate.slice(1)

describe('the demo wipe', () => {
  it('covers every table that carries a user (User itself is kept)', () => {
    const userTables = NON_DEMO_TABLES.map(([t]) => t).filter((t) => t !== 'User')
    expect(new Set(WIPE_ORDER.map(asTable))).toEqual(new Set(userTables))
  })

  it("clears an Item's dependents before the Item", () => {
    const at = (t: string) => WIPE_ORDER.indexOf(t as (typeof WIPE_ORDER)[number])
    for (const child of ['subscriptionMark', 'transaction', 'account', 'recurringStream']) {
      expect(at(child), child).toBeLessThan(at('plaidItem'))
    }
  })
})

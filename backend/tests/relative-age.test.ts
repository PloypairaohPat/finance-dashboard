// The Plaid-items inventory's "streams refreshed" column: a relative age,
// never a date, so a stalled refresh shows without printing when it ran.

import { describe, expect, it } from 'vitest'
import { relativeAge } from '../scripts/lib/relativeAge'

const now = new Date(Date.UTC(2026, 9, 6, 12, 0))
const ago = (ms: number) => new Date(now.getTime() - ms)

describe('relativeAge', () => {
  it('says never for an Item not yet refreshed', () => {
    expect(relativeAge(null, now)).toBe('never')
    expect(relativeAge(undefined, now)).toBe('never')
  })

  it('counts minutes, then hours, then days', () => {
    expect(relativeAge(ago(5 * 60_000), now)).toBe('5 min ago')
    expect(relativeAge(ago(3 * 3_600_000), now)).toBe('3 h ago')
    expect(relativeAge(ago(47 * 3_600_000), now)).toBe('47 h ago')
    expect(relativeAge(ago(3 * 86_400_000), now)).toBe('3 d ago')
  })

  it('never prints a date', () => {
    for (const ms of [0, 59 * 60_000, 3_600_000, 86_400_000 * 40]) {
      expect(relativeAge(ago(ms), now)).not.toMatch(/\d{4}|-\d\d-|\//)
    }
  })
})

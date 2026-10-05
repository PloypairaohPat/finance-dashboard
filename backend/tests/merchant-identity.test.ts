// ─────────────────────────────────────────────────────────────────
//  merchantIdentity: the one definition of "the same merchant" that
//  detection, marks, the tab, the bell and price-up all share.
//  All ids are invented.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest'
import { merchantIdentity, normalizeMerchant } from '../src/lib/merchantIdentity'

const t = (merchantEntityId: string | null, counterpartyEntities: string[] | null, label = 'Some Label') =>
  ({ merchantEntityId, counterpartyEntities, label })

describe('merchantIdentity', () => {
  it("uses merchant_entity_id, so one merchant's look-alike names are one merchant", () => {
    const a = merchantIdentity(t('ent-gym', ['merchant:ent-gym'], 'IRONLINE FITNESS'))
    const b = merchantIdentity(t('ent-gym', [], 'SQ *IRONLINE CLUB'))
    expect(a).toBe('entity:ent-gym')
    expect(b).toBe(a)
  })

  it.each(['payment_app', 'payment_terminal', 'marketplace', 'financial_institution'])(
    'never keys on merchant_entity_id when it is a %s counterparty\'s id',
    (rail) => {
      const one = merchantIdentity(t('ent-rail', [`${rail}:ent-rail`], 'Payee One'))
      const two = merchantIdentity(t('ent-rail', [`${rail}:ent-rail`], 'Payee Two'))
      expect(one).toBe('payeeone')
      expect(two).toBe('payeetwo')
    },
  )

  it("falls back to a merchant counterparty's entity id, never a rail's", () => {
    expect(merchantIdentity(t(null, ['payment_terminal:ent-term', 'merchant:ent-cafe']))).toBe('entity:ent-cafe')
    expect(merchantIdentity(t(null, ['payment_app:ent-app'], 'Rent Share'))).toBe('rentshare')
    // merchant_entity_id on a rail, but a merchant counterparty is there too.
    expect(merchantIdentity(t('ent-mkt', ['marketplace:ent-mkt', 'merchant:ent-shop']))).toBe('entity:ent-shop')
  })

  it('falls back to the normalised name, exactly as detection keyed it before ids existed', () => {
    expect(merchantIdentity(t(null, [], 'Help.Hbomax.Com Hbomax'))).toBe(normalizeMerchant('Hbo Max'))
    expect(merchantIdentity(t(null, null, 'Streambox'))).toBe('streambox')
  })

  it('ignores malformed counterparty entries', () => {
    expect(merchantIdentity(t(null, ['merchant:', ':ent-x', 'garbage'], 'Corner Shop'))).toBe('cornershop')
  })
})

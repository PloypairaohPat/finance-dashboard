// ─────────────────────────────────────────────────────────────────
//  merchantIdentity — what "the same merchant" means, everywhere.
//
//  Subscription detection, marks, the Subscriptions tab, the bell and
//  price-up all group by this one key. It is computed from the raw id
//  columns on every read and never stored, so changing the rule here
//  changes every consumer at once with nothing to backfill.
//
//  The rule (taxonomy audit, M7.3):
//    1. merchant_entity_id — unless that same id belongs to a counterparty
//       that is a rail (payment_app, payment_terminal, marketplace,
//       financial_institution). On a rail the id names the rail, and keying
//       on it would merge every payee or merchant behind it.
//    2. else the entity id of a counterparty whose type is merchant;
//    3. else the normalised name. Permanent, not a stopgap: many rows carry
//       no id at all.
//
//  Keys: "entity:<id>" for an id, the bare normalised name otherwise. A
//  normalised name is [a-z0-9] only, so the two can never collide, and a
//  name-keyed key is exactly what it was before ids existed — price-up
//  fingerprints built on it don't change.
// ─────────────────────────────────────────────────────────────────

export const RAIL_COUNTERPARTY_TYPES: ReadonlySet<string> = new Set([
  'payment_app', 'payment_terminal', 'marketplace', 'financial_institution',
])

/**
 * Collapse a merchant label to a grouping key: "Hbo Max", "Hbomax" and
 * "Help.Hbomax.Com Hbomax" all become "hbomax".
 */
export function normalizeMerchant(raw: string): string {
  // Strip noise prefixes and TLDs, then collapse to alphanumeric lowercase.
  const cleaned = raw
    .replace(/\b(help|pay|payments?|www|http|https)\b/gi, '')
    .replace(/\.com\b|\.net\b|\.org\b|\.io\b/gi, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
  // A simple repetition ("hbomaxhbomax") keys as its base unit.
  const n = cleaned.length
  for (let l = 2; l <= Math.floor(n / 2); l++) {
    if (n % l === 0 && cleaned.slice(0, l).repeat(n / l) === cleaned) return cleaned.slice(0, l)
  }
  return cleaned
}

export interface IdentityInput {
  merchantEntityId: string | null
  /** "<type>:<entity_id>" per counterparty (see entityColumns). NULL on a row nothing has filled. */
  counterpartyEntities: readonly string[] | null
  /** What the app shows as the merchant: cleanName, else name. */
  label: string
}

function parse(entry: string): { type: string; id: string } | null {
  const i = entry.indexOf(':')
  if (i <= 0 || i === entry.length - 1) return null
  return { type: entry.slice(0, i), id: entry.slice(i + 1) }
}

/** The entity id the rule picks, or null when it falls back to the name. */
export function identityEntityId(t: Pick<IdentityInput, 'merchantEntityId' | 'counterpartyEntities'>): string | null {
  const counterparties = (t.counterpartyEntities ?? []).map(parse).filter((c): c is { type: string; id: string } => c !== null)
  const mid = t.merchantEntityId
  if (mid && !counterparties.some((c) => c.id === mid && RAIL_COUNTERPARTY_TYPES.has(c.type))) return mid
  return counterparties.find((c) => c.type === 'merchant')?.id ?? null
}

export function merchantIdentity(t: IdentityInput): string {
  const id = identityEntityId(t)
  return id ? `entity:${id}` : normalizeMerchant(t.label)
}

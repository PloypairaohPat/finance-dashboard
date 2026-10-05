// ─────────────────────────────────────────────────────────────────
//  entityColumns — Plaid's entity ids, as stored on Transaction.
//
//  One function for every writer: plaidSync on create and update, the demo
//  seed, and the backfill from rawJson. Raw ids only; deciding which id names
//  the merchant is the identity rule's job, not this one's.
// ─────────────────────────────────────────────────────────────────

export interface EntityColumns {
  merchantEntityId: string | null
  /** "<type>:<entity_id>" for each counterparty that has an entity id, in Plaid's order. */
  counterpartyEntities: string[]
}

/** The part of a Plaid transaction this reads. Loose on purpose: rawJson is untyped. */
export interface PlaidEntityFields {
  merchant_entity_id?: unknown
  counterparties?: unknown
}

const nonEmpty = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null

export function entityColumns(txn: PlaidEntityFields | null | undefined): EntityColumns {
  const counterparties = Array.isArray(txn?.counterparties) ? txn!.counterparties : []
  const counterpartyEntities: string[] = []
  for (const c of counterparties as Array<Record<string, unknown> | null>) {
    const id = nonEmpty(c?.entity_id)
    if (!id) continue
    counterpartyEntities.push(`${(nonEmpty(c?.type) ?? 'unknown').toLowerCase()}:${id}`)
  }
  return { merchantEntityId: nonEmpty(txn?.merchant_entity_id), counterpartyEntities }
}

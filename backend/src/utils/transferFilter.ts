import prisma from "../lib/prisma"

type TransferTx = {
  id: string
  date: Date
  amount: number
  accountId: string
  categoryPrimary: string | null
}

export interface FilterResult {
  internalIds: Set<string>
  soloCount: number    // individual transactions matched by counterparty (Tier 1)
  pairedCount: number  // pairs matched by amount pairing (Tier 2)
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")

/**
 * Tier 2: same-day opposite-amount pair match on candidates not already solo-matched.
 */
function pairMatch(
  candidates: TransferTx[],
  soloIds: Set<string>,
): Set<string> {
  const remaining = candidates.filter(c => !soloIds.has(c.id))
  const byDate = new Map<string, TransferTx[]>()
  for (const tx of remaining) {
    const key = tx.date.toISOString().slice(0, 10)
    const arr = byDate.get(key) ?? []
    arr.push(tx)
    byDate.set(key, arr)
  }
  const paired = new Set<string>()
  for (const [, dayTxs] of byDate) {
    const pool = [...dayTxs]
    for (let i = 0; i < pool.length; i++) {
      const a = pool[i]
      for (let j = i + 1; j < pool.length; j++) {
        const b = pool[j]
        if (a.accountId !== b.accountId && Math.abs(a.amount + b.amount) < 0.01) {
          paired.add(a.id)
          paired.add(b.id)
          pool.splice(j, 1)
          pool.splice(i, 1)
          i--
          break
        }
      }
    }
  }
  return paired
}

/**
 * Two-tier internal transfer filter.
 *
 * Tier 1 (solo): A single TRANSFER_IN/OUT is flagged when its Plaid counterparties[]
 * contains an entry with type === "financial_institution" whose name normalizes to one
 * of the user's linked institution names. Works even when only one leg has settled.
 *
 * Tier 2 (pair): Falls back to same-day, opposite-amount pair matching for transfers
 * that didn't match Tier 1.
 *
 * Pass `linkedInstitutionNames` to avoid redundant DB round-trips when calling this
 * multiple times in the same request.
 */
export async function filterInternalTransfers(
  userId: string,
  txs: TransferTx[],
  userAccountIds: Set<string>,
  linkedInstitutionNames?: string[],
): Promise<FilterResult> {
  const candidates = txs.filter(
    t => userAccountIds.has(t.accountId) && /^TRANSFER_(IN|OUT)/i.test(t.categoryPrimary ?? ""),
  )

  if (candidates.length === 0) {
    return { internalIds: new Set(), soloCount: 0, pairedCount: 0 }
  }

  // Fetch linked institution names once if caller didn't pre-supply them
  let instNames = linkedInstitutionNames
  if (!instNames) {
    const items = await prisma.plaidItem.findMany({
      where: { userId },
      select: { institutionName: true },
    })
    instNames = items.map(i => i.institutionName).filter(Boolean) as string[]
  }
  const normalizedInstitutions = new Set(instNames.map(normalize))

  // Tier 1 — fetch rawJson only for transfer candidates (targeted query)
  const rawRows = await prisma.transaction.findMany({
    where: { id: { in: candidates.map(c => c.id) } },
    select: { id: true, rawJson: true },
  })

  const soloIds = new Set<string>()
  for (const row of rawRows) {
    const counterparties: Array<{ name?: string; type?: string }> =
      (row.rawJson as any)?.counterparties ?? []
    const isOwnInstitution = counterparties.some(
      cp =>
        cp.type === "financial_institution" &&
        normalizedInstitutions.has(normalize(cp.name ?? "")),
    )
    if (isOwnInstitution) soloIds.add(row.id)
  }

  // Tier 2 — pair match on what Tier 1 didn't catch
  const pairedIds = pairMatch(candidates, soloIds)

  const internalIds = new Set<string>([...soloIds, ...pairedIds])
  return {
    internalIds,
    soloCount: soloIds.size,
    pairedCount: pairedIds.size / 2,  // return as pair count, not individual IDs
  }
}

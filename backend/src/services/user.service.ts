import prisma from '../lib/prisma'
import { DEMO_USER_ID } from '../middleware/auth'

// Clerk authenticates users but never creates a row in our own User table.
// Call this before any write with a FK to User (PlaidItem, Account, Transaction)
// so the first such write for a brand-new user doesn't hit the FK constraint.
// Idempotent — safe to call on every request.
export async function ensureUser(userId: string): Promise<void> {
  if (userId === DEMO_USER_ID) return

  await prisma.user.upsert({
    where:  { id: userId },
    update: {},
    create: { id: userId },
  })
}

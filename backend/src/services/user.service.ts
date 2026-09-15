import prisma from '../lib/prisma'
import { DEMO_USER_ID } from '../middleware/auth'
import { DEFAULT_PERIOD_START_DAY } from '../lib/period'

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

// ── M7.2 — period start day ─────────────────────────────────────────
// A user with no User row yet (signed in, nothing linked) has never chosen
// one, so they get the default: calendar months.
export async function getPeriodStartDay(userId: string): Promise<number> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { periodStartDay: true },
  })
  return row?.periodStartDay ?? DEFAULT_PERIOD_START_DAY
}

// Callers validate the value (isValidPeriodStartDay) first. The demo user is
// refused here too, as a second line behind the demoReadOnly middleware.
export async function setPeriodStartDay(userId: string, periodStartDay: number): Promise<number> {
  if (userId === DEMO_USER_ID) throw new Error('Demo settings are read-only')
  await ensureUser(userId)
  const row = await prisma.user.update({
    where: { id: userId },
    data: { periodStartDay },
    select: { periodStartDay: true },
  })
  return row.periodStartDay
}

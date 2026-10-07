import prisma from '../lib/prisma'
import { DEMO_USER_ID } from '../middleware/auth'
import { regularPaycheckFound } from './missedPaycheck.service'
import { DEFAULT_PERIOD_START_DAY } from '../lib/period'

// Clerk authenticates users but never creates a row in our own User table.
// Call this before any write with a FK to User — PlaidItem, Account, Transaction,
// and since the user_foreign_keys migration Budget, Goal, Alert and
// BalanceSnapshot too — so the first such write for a brand-new user doesn't hit
// the FK constraint. (Alert and BalanceSnapshot rows only come from data that
// already needs the User row, so only budget and goal creation call it.)
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

// ── M7.3 — payment-app inflows as income ────────────────────────────
// Read by the classifier, not by a caller: see classification.service's
// getClassifierSettings. This is the settings API's view of the same column.
export interface UserSettings {
  periodStartDay: number
  paymentAppInflowsAreIncome: boolean
  /** M7.6 PR 6b — the missed-paycheck alert, opt-in. */
  missedPaycheckAlerts: boolean
}

/** What GET /user/settings answers: the settings, and whether the paycheck alert has anything to watch. */
export interface UserSettingsView extends UserSettings {
  /** A regular paycheck the missed-paycheck alert could watch exists. Read-only. */
  regularPaycheckFound: boolean
}

const SETTINGS_SELECT = { periodStartDay: true, paymentAppInflowsAreIncome: true, missedPaycheckAlerts: true } as const

export async function getUserSettings(userId: string): Promise<UserSettingsView> {
  const [row, found] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: SETTINGS_SELECT }),
    regularPaycheckFound(userId),
  ])
  return {
    periodStartDay: row?.periodStartDay ?? DEFAULT_PERIOD_START_DAY,
    paymentAppInflowsAreIncome: row?.paymentAppInflowsAreIncome ?? false,
    missedPaycheckAlerts: row?.missedPaycheckAlerts ?? false,
    regularPaycheckFound: found,
  }
}

/**
 * Save whichever settings were sent. The demo user is refused here too, as a
 * second line behind the demoReadOnly middleware.
 *
 * Nothing is recomputed or stored: verdicts are derived on read, so a change
 * takes effect for every period at once, past ones included.
 */
export async function updateUserSettings(
  userId: string,
  patch: Partial<UserSettings>,
): Promise<UserSettingsView> {
  if (userId === DEMO_USER_ID) throw new Error('Demo settings are read-only')
  await ensureUser(userId)
  const row = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(patch.periodStartDay !== undefined && { periodStartDay: patch.periodStartDay }),
      ...(patch.paymentAppInflowsAreIncome !== undefined && {
        paymentAppInflowsAreIncome: patch.paymentAppInflowsAreIncome,
      }),
      ...(patch.missedPaycheckAlerts !== undefined && {
        missedPaycheckAlerts: patch.missedPaycheckAlerts,
      }),
    },
    select: SETTINGS_SELECT,
  })
  return { ...row, regularPaycheckFound: await regularPaycheckFound(userId) }
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

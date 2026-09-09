// ─────────────────────────────────────────────────────────────────
//  tabs.ts — the five top-level destinations, in display order.
//
//  Single source of truth for path + label so the <Routes> in App.tsx and
//  the nav added in M7.1 stage 4 cannot drift apart.
//
//  Overview is the index route rather than "/overview": it is where the app
//  lands, and giving it a second URL would mean two addresses for one view.
// ─────────────────────────────────────────────────────────────────

export interface TabDef {
  /** Stable key — safe to use for nav state and analytics. */
  id: string
  label: string
  path: string
}

export const TABS: TabDef[] = [
  { id: 'overview', label: 'Overview', path: '/' },
  { id: 'accounts', label: 'Accounts', path: '/accounts' },
  { id: 'budgets', label: 'Budgets', path: '/budgets' },
  { id: 'transactions', label: 'Transactions', path: '/transactions' },
  { id: 'subscriptions', label: 'Subscriptions & Bills', path: '/subscriptions' },
]

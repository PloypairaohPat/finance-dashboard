import { createContext, ReactNode, useContext } from "react"

// ─────────────────────────────────────────────────────────────────
//  SyncProvider — tells every view when bank data has changed.
//
//  App owns a counter and bumps it after anything that pulls new data from
//  the bank: the Sync button, the auto-sync, Live Balances (which ends in a
//  sync), and linking a bank. This provider, mounted above <Routes>, hands
//  that number to every view.
//
//  A view that shows synced data adds `useSyncVersion()` to its fetch
//  effect's dependencies, so it re-fetches after each sync. Views on routes
//  that aren't open need nothing: they fetch fresh when they mount.
//
//  Two rules for a fetch that re-runs on sync:
//    - Keep showing the data it already has while the new data loads; don't
//      drop back to a loading skeleton.
//    - Ignore a response that a newer fetch has superseded (a cancelled flag
//      in the effect cleanup, or a request counter for shared reloads), or a
//      slow pre-sync response can overwrite the fresh one.
// ─────────────────────────────────────────────────────────────────

const SyncVersionContext = createContext(0)

/** Increases after every change to synced bank data. Use it as an effect dependency. */
export function useSyncVersion(): number {
  return useContext(SyncVersionContext)
}

export default function SyncProvider({ version, children }: { version: number; children: ReactNode }) {
  return <SyncVersionContext.Provider value={version}>{children}</SyncVersionContext.Provider>
}

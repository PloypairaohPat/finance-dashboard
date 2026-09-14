// ─────────────────────────────────────────────────────────────────
//  App.tsx  —  Ledger Personal Finance Dashboard
// ─────────────────────────────────────────────────────────────────

import React, { useState, useCallback, useEffect, useMemo, useRef, CSSProperties } from "react";
// Declarative mode only — BrowserRouter/Routes/Route. Deliberately NOT
// createBrowserRouter: the data router's loaders/actions and react-router's
// framework mode both need build-tool integration that CRA cannot provide.
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { usePlaidLink, PlaidLinkOnSuccessMetadata, PlaidLinkError } from "react-plaid-link";
import SubscriptionsView from "./SubscriptionsView";
import { Account, CategorySpend } from "./types"
import BudgetsView from "./BudgetsView"
import TransactionsView from "./TransactionsView"
import OverviewView from "./OverviewView"
import AppHeader from "./AppHeader"
import AlertsProvider from "./AlertsProvider"
import SyncProvider from "./SyncProvider"
import { readWriteResult } from "./lib/writeResult"
import useMediaQuery from "./useMediaQuery"
import {
  SignedIn,
  SignedOut,
  SignIn,
  UserButton,
  useAuth,
} from "@clerk/clerk-react";
import { API_URL } from "./config"
import { DemoContext } from "./lib/DemoContext"
import { readInitialDemoMode, persistDemoMode } from "./lib/demoMode"
import AccountsView from "./AccountsView"
import DemoUrlSync from "./DemoUrlSync"
import { TABS } from "./tabs"

// ── Styles ────────────────────────────────────────────────────────
const styles: Record<string, CSSProperties | ((...args: any[]) => CSSProperties)> = {
  root: {
    minHeight: "100vh",
    background: "#0a0a0a",
    color: "#f0ede8",
    fontFamily: "'Syne', sans-serif",
    padding: "0",
    margin: "0",
  },
  header: {
    borderBottom: "1px solid #222",
    padding: "24px 40px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    background: "#0d0d0d",
  },
  main:      { maxWidth: "900px", margin: "0 auto", padding: "60px 40px" },
  hero:      { marginBottom: "60px" },
  heroTitle: {
    fontSize: "52px",
    fontWeight: 800,
    lineHeight: 1.05,
    letterSpacing: "-2px",
    marginBottom: "16px",
    color: "#f0ede8",
  },
  heroSub: {
    fontSize: "16px",
    color: "#888",
    fontFamily: "'IBM Plex Mono', monospace",
    lineHeight: 1.6,
  },
  stepList: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "12px",
    margin: "32px 0 48px",
  },
  step: (done: boolean) => ({
    padding: "14px 18px",
    border: `1px solid ${done ? "#00e5a030" : "#222"}`,
    borderRadius: "8px",
    background: done ? "#0d1f15" : "#111",
    display: "flex",
    alignItems: "center",
    gap: "12px",
    transition: "all 0.3s",
  }),
  stepDot: (done: boolean) => ({
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    background: done ? "#00e5a0" : "#333",
    flexShrink: 0,
    transition: "all 0.3s",
    boxShadow: done ? "0 0 8px #00e5a080" : "none",
  }),
  stepLabel: (done: boolean) => ({
    fontSize: "13px",
    fontFamily: "'IBM Plex Mono', monospace",
    color: done ? "#00e5a0" : "#555",
    transition: "color 0.3s",
  }),
  connectBtn: {
    background: "#00e5a0",
    color: "#000",
    border: "none",
    padding: "16px 36px",
    fontSize: "16px",
    fontWeight: 700,
    fontFamily: "'Syne', sans-serif",
    borderRadius: "8px",
    cursor: "pointer",
    letterSpacing: "-0.3px",
    transition: "all 0.2s",
  },
  loadingBtn: {
    background: "#1a2e20",
    color: "#00e5a080",
    border: "1px solid #00e5a020",
    padding: "16px 36px",
    fontSize: "16px",
    fontWeight: 700,
    fontFamily: "'Syne', sans-serif",
    borderRadius: "8px",
    cursor: "not-allowed",
    letterSpacing: "-0.3px",
  },
  hint:       { marginTop: "12px", fontFamily: "'IBM Plex Mono', monospace", fontSize: "12px", color: "#555" },
  section:    { marginTop: "60px" },
  sectionHeader: {
    display: "flex",
    alignItems: "baseline",
    gap: "12px",
    marginBottom: "24px",
    borderBottom: "1px solid #1a1a1a",
    paddingBottom: "16px",
  },
  sectionTitle: { fontSize: "22px", fontWeight: 700, letterSpacing: "-0.5px" },
  sectionCount: { fontFamily: "'IBM Plex Mono', monospace", fontSize: "12px", color: "#555" },
  error: {
    background: "#1a0d0d",
    border: "1px solid #ff6b6b30",
    borderRadius: "8px",
    padding: "16px 20px",
    color: "#ff6b6b",
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: "13px",
    marginTop: "20px",
  },
};

// ── Placeholder tab view ──────────────────────────────────────────
// M7.1 stage 1 ships the routes empty on purpose: this stage proves URLs,
// deep-linking and the SPA fallback work before any component moves. Stage 2
// replaces each of these with a real view, one tab at a time.
function PlaceholderView({ title }: { title: string }) {
  return (
    <div style={styles.root as CSSProperties}>
      <main style={{ maxWidth: 900, margin: "0 auto", padding: "60px 40px" }}>
        <h1 style={{
          fontFamily: "Fraunces, Georgia, serif", fontWeight: 300,
          fontSize: 32, color: "#e8f4e8", marginBottom: 12,
        }}>{title}</h1>
        <p style={{
          fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: "#5a7a5a",
        }}>
          This tab is empty until M7.1 stage 2 moves its components here.
        </p>
      </main>
    </div>
  )
}

// ── Main App ──────────────────────────────────────────────────────
export default function App() {
  const [linkToken,    setLinkToken]    = useState<string | null>(null);
  const [connected,    setConnected]    = useState(false);
  const [accounts,     setAccounts]     = useState<Account[]>([]);
  const [categories,   setCategories]   = useState<CategorySpend[]>([]);
  // Bumped whenever synced bank data changes — after a successful Sync (button,
  // auto-sync, Live Balances) and after linking a bank. SyncProvider hands it
  // to every view that shows synced data so each re-fetches (M7.1 stage 4).
  const [syncVersion, setSyncVersion] = useState(0);
  // Shown next to the Sync button on every route, e.g. a demo-mode refusal.
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [netWorthHistory, setNetWorthHistory] = useState<Array<{ date: string; netWorth: number }>>([]);
  const [loading,      setLoading]      = useState({ link: true, accounts: false, tx: false });
  const [error,        setError]        = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);

  const [monthSaved,   setMonthSaved]   = useState<number | null>(null)
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null)
  const [syncing,        setSyncing]        = useState(false)
  const [updateLinkToken, setUpdateLinkToken] = useState<string | null>(null)
  const [updatingBalance, setUpdatingBalance] = useState(false)
  const hasAutoSynced = useRef(false)

  const isMobile = useMediaQuery("(max-width: 640px)")
  const { getToken, isSignedIn, isLoaded } = useAuth();

  // ── Demo mode — lets visitors view the dashboard without logging in ──
  // Entry is either `?demo=1` or a stored session; see lib/demoMode.ts.
  const [demoMode, setDemoMode] = useState(readInitialDemoMode);

  // Persist to sessionStorage so demo survives a hard refresh. The matching
  // `?demo=1` URL write is DemoUrlSync's job — it has to go through the router
  // or React Router's location.search goes stale.
  useEffect(() => {
    persistDemoMode(demoMode);
  }, [demoMode]);

  // ── Authenticated fetch wrapper ──────────────────────────────────
  const authFetch = useCallback(
    async (url: string, options: RequestInit = {}) => {
      if (demoMode) {
        return fetch(url, {
          ...options,
          headers: {
            ...options.headers,
            "Content-Type": "application/json",
            "X-Demo-Mode": "1",
          },
        });
      }
      const token = await getToken();
      return fetch(url, {
        ...options,
        headers: {
          ...options.headers,
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
    },
    [getToken, demoMode]
  );

  // ── M5.1 — Hero Overview derived values ─────────────────────────
  const heroProps = useMemo(() => {
    const cashAvailable = accounts
      .filter(a => a.type === "depository")
      .reduce((sum, a) => sum + (Number(a.currentBalance) || 0), 0)

    const debt = accounts
      .filter(a => a.type === "credit" || a.type === "loan")
      .reduce((sum, a) => sum + Math.abs(Number(a.currentBalance) || 0), 0)

    const latest = netWorthHistory[netWorthHistory.length - 1]
    const monthAgoIdx = Math.max(0, netWorthHistory.length - 31)
    const monthAgo = netWorthHistory[monthAgoIdx]
    const netWorth = latest?.netWorth ?? null
    const netWorthMomPct =
      latest && monthAgo && monthAgo.netWorth !== 0
        ? ((latest.netWorth - monthAgo.netWorth) / Math.abs(monthAgo.netWorth)) * 100
        : null

    const now = new Date()
    const monthLabel = now.toLocaleString("en-US", { month: "long" })
    const lastSyncAt = lastSyncedAt

    return { netWorth, netWorthMomPct, cashAvailable, debt, monthSaved, monthLabel, lastSyncAt }
  }, [accounts, netWorthHistory, monthSaved, lastSyncedAt])

  // ── Auto-connect check ───────────────────────────────────────────
  useEffect(() => {
    if (!demoMode && !isLoaded) return;
    if (!demoMode && !isSignedIn) { setInitialLoading(false); return; }

    (async () => {
      try {
        const res = await authFetch(`${API_URL}/accounts`);
        const data = await res.json() as { accounts: Account[]; lastSyncedAt?: string | null; error?: string };
        if (data.accounts && data.accounts.length > 0) {
          setConnected(true);
          setAccounts(data.accounts);
          setLastSyncedAt(data.lastSyncedAt ?? null);
        }
      } catch (err) {
        console.error("Auto-connect check failed:", err);
      } finally {
        setInitialLoading(false);
      }
    })();
  }, [authFetch, isSignedIn, demoMode]);

  // ── Fetch link token ─────────────────────────────────────────────
  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    (async () => {
      try {
        const res  = await authFetch(`${API_URL}/create_link_token`, { method: "POST" });
        const data = await res.json() as { link_token: string; error?: string };
        if (data.error) throw new Error(data.error);
        setLinkToken(data.link_token);
      } catch (e: any) {
        setError(`Failed to get link token: ${e.message}`);
      } finally {
        setLoading((l) => ({ ...l, link: false }));
      }
    })();
  }, [authFetch, isSignedIn]);

  const fetchNetWorth = useCallback(async () => {
    try {
      const res  = await authFetch(`${API_URL}/networth`)
      const data = await res.json() as { history?: Array<{ date: string; netWorth: number }> }
      setNetWorthHistory(data.history ?? [])
    } catch (e: any) {
      console.error("Net worth fetch failed:", e.message)
    }
  }, [authFetch])

  const fetchInsightsSummary = useCallback(async () => {
    try {
      const res  = await authFetch(`${API_URL}/insights`)
      const data = await res.json() as { summary?: { netSaved: number } }
      setMonthSaved(data.summary?.netSaved ?? null)
    } catch (e: any) {
      console.error("Insights summary fetch failed:", e.message)
    }
  }, [authFetch])

  // ── Fetch all dashboard data ─────────────────────────────────────
  const fetchData = useCallback(async () => {
    setLoading((l) => ({ ...l, accounts: true }));

    try {
      const res  = await authFetch(`${API_URL}/accounts`);
      const data = await res.json() as { accounts: Account[]; lastSyncedAt?: string | null; error?: string };
      if (data.error) throw new Error(data.error);
      setAccounts(data.accounts);
      setLastSyncedAt(data.lastSyncedAt ?? null);
    } catch (e: any) {
      setError(`Accounts fetch failed: ${e.message}`);
    } finally {
      setLoading((l) => ({ ...l, accounts: false }));
    }

    try {
      const res  = await authFetch(`${API_URL}/categories`);
      const data = await res.json() as { categories: CategorySpend[]; error?: string };
      if (data.error) throw new Error(data.error);
      setCategories(data.categories || []);
    } catch (e: any) {
      setError(`Categories fetch failed: ${e.message}`);
    }
  }, [authFetch]);

  const triggerRefresh = useCallback(async () => {
    setSyncing(true)
    setSyncNotice(null)
    try {
      const syncRes = await authFetch(`${API_URL}/sync`, { method: "POST" })
      // Not res.ok alone: in demo mode the backend refuses every write with
      // HTTP 200 { demo: true, ok: false }, which res.ok reads as a sync.
      const result = await readWriteResult(syncRes)
      if (!result.ok) {
        if (result.demo) {
          // Nothing synced, so there is nothing to re-fetch. Not an error.
          setSyncNotice(result.message)
          return
        }
        throw new Error(result.message)
      }
      // Every view that shows synced data re-fetches off this, in parallel with
      // App's own fetches below.
      setSyncVersion((v) => v + 1)
      await Promise.all([
        fetchData(),
        fetchNetWorth(),
        fetchInsightsSummary(),
      ])
    } catch (e: any) {
      console.error("Sync failed:", e.message)
      // Shown next to the Sync button, which is on every route; the connect
      // panel's error slot only exists on Overview.
      setSyncNotice(`Sync failed: ${e.message}`)
    } finally {
      setSyncing(false)
    }
  }, [authFetch, fetchData, fetchNetWorth, fetchInsightsSummary])

  useEffect(() => {
    if (!demoMode && (!isLoaded || !isSignedIn)) return;
    fetchData();
    fetchNetWorth();
    fetchInsightsSummary();
  }, [fetchData, fetchNetWorth, fetchInsightsSummary, isSignedIn, demoMode])

  useEffect(() => {
    // Never in demo: the backend refuses the write, so an automatic Sync would
    // only greet every demo visitor with "changes aren't saved".
    if (demoMode || !lastSyncedAt || !connected || hasAutoSynced.current) return
    if (Date.now() - new Date(lastSyncedAt).getTime() > 4 * 60 * 60 * 1000) {
      hasAutoSynced.current = true
      triggerRefresh()
    }
  }, [demoMode, lastSyncedAt, connected, triggerRefresh])

  const onSuccess = useCallback(
    async (public_token: string, metadata: PlaidLinkOnSuccessMetadata) => {
      console.log("✅ Plaid Link success!", metadata.institution);
      try {
        const res  = await authFetch(`${API_URL}/exchange_public_token`, {
          method: "POST",
          body: JSON.stringify({ public_token }),
        });
        const data = await res.json() as { error?: string };
        if (data.error) throw new Error(data.error);
        setConnected(true);
        fetchData();
        // A newly linked bank changes every synced view, not just App's
        // accounts. Before stage 4 this path only called fetchData — the same
        // gap Sync had.
        setSyncVersion((v) => v + 1);
      } catch (e: any) {
        setError(`Token exchange failed: ${e.message}`);
      }
    },
    [authFetch, fetchData]
  );

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess,
    onExit: (err: PlaidLinkError | null) => {
      if (err) setError(`Plaid Link exited with error`);
    },
  });

  // ── Update mode — adds balance product to existing Item ──────────
  const onUpdateSuccess = useCallback(
    async (_publicToken: string, _metadata: PlaidLinkOnSuccessMetadata) => {
      // In update mode the access_token is unchanged — no token exchange needed.
      setUpdateLinkToken(null)
      setUpdatingBalance(false)
      await triggerRefresh()
    },
    [triggerRefresh]
  )

  const { open: openUpdate, ready: readyUpdate } = usePlaidLink({
    token: updateLinkToken,
    onSuccess: onUpdateSuccess,
    onExit: () => {
      setUpdateLinkToken(null)
      setUpdatingBalance(false)
    },
  })

  useEffect(() => {
    if (updateLinkToken && readyUpdate) openUpdate()
  }, [updateLinkToken, readyUpdate, openUpdate])

  const startBalanceUpdate = useCallback(async () => {
    setUpdatingBalance(true)
    try {
      const res  = await authFetch(`${API_URL}/create-update-link-token`, { method: 'POST' })
      const data = await res.json() as { link_token: string; error?: string }
      if (data.error) throw new Error(data.error)
      setUpdateLinkToken(data.link_token)
    } catch (e: any) {
      console.error('Balance update failed:', e.message)
      setError(`Balance refresh failed: ${e.message}`)
      setUpdatingBalance(false)
    }
  }, [authFetch])

  const steps = [
    { label: "backend scaffolded",    done: true },
    { label: "link_token endpoint",   done: !!linkToken },
    { label: "exchange_public_token", done: connected },
    { label: "plaid link UI mounted", done: !!linkToken },
    { label: "wells fargo connected", done: connected },
    { label: "balances fetched",      done: accounts.length > 0 },
    { label: "transactions fetched",  done: connected },
  ];

  // ── Initial loading splash ───────────────────────────────────────
  // Deliberately a const rather than the early `return` this used to be.
  // Every branch App can render has to end up inside the BrowserRouter at the
  // bottom of this function; returning here would leave the splash outside
  // router context, so anything added to it later that touches a router hook
  // would throw only on the slow-network path that shows it.
  const splash = (
    <div style={{
      display: "flex", flexDirection: "column",
      justifyContent: "center", alignItems: "center",
      height: "100vh", background: "#0a0f0c", gap: "16px",
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{
          fontFamily: "Fraunces, Georgia, serif", fontWeight: 300,
          fontSize: 24, color: "#e8f4e8", letterSpacing: "-.01em",
        }}>Ledger</span>
        <span style={{
          fontFamily: "'IBM Plex Mono', monospace", fontSize: 11,
          color: "#5a7a5a", letterSpacing: ".06em",
        }}>v0.5</span>
      </div>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "13px", color: "#5a7a5a" }}>
        Loading your dashboard…
      </div>
    </div>
  );

  // ── App header pieces — rendered by AppHeader above <Routes> ─────
  // Built here because they drive App-owned Plaid Link, refresh and demo
  // state. `overviewActions` shows on the Overview route only (+ Link Account
  // reveals the connect panel, which only exists there); `syncActions`, the
  // bell and `accountControl` show on every route.
  const overviewActions = connected ? (
            <button
              onClick={() => setConnected(false)}
              style={{
                background: "transparent", border: "1px solid #333", color: "#666",
                padding: "4px 12px", borderRadius: "4px", cursor: "pointer",
                fontSize: "11px", fontFamily: "'IBM Plex Mono', monospace",
              }}
            >
              + Link Account
            </button>
  ) : null;

  // Sync can sit on every route because every view that shows synced data
  // re-fetches when triggerRefresh bumps syncVersion (SyncProvider).
  const syncActions = (
        <>
          {connected && (
            <button
              onClick={triggerRefresh}
              disabled={syncing}
              style={{
                background: "transparent",
                border: `1px solid ${syncing ? "#00e5a040" : "#333"}`,
                color: syncing ? "#00e5a0" : "#666",
                padding: "4px 12px", borderRadius: "4px",
                cursor: syncing ? "not-allowed" : "pointer",
                fontSize: "11px", fontFamily: "'IBM Plex Mono', monospace",
                transition: "color 0.2s, border-color 0.2s",
              }}
            >
              {syncing ? "syncing…" : "↻ Sync"}
            </button>
          )}
          {connected && (
            <button
              onClick={startBalanceUpdate}
              disabled={updatingBalance}
              title="Re-authenticate with your bank to enable real-time balance fetching"
              style={{
                background: "transparent",
                border: `1px solid ${updatingBalance ? "#f59e0b40" : "#333"}`,
                color: updatingBalance ? "#f59e0b" : "#666",
                padding: "4px 12px", borderRadius: "4px",
                cursor: updatingBalance ? "not-allowed" : "pointer",
                fontSize: "11px", fontFamily: "'IBM Plex Mono', monospace",
                transition: "color 0.2s, border-color 0.2s",
              }}
            >
              {updatingBalance ? "opening…" : "⚡ Live Balances"}
            </button>
          )}
          {/* Sync's outcome when it didn't simply work: a demo-mode refusal or a
              failure. Next to the button so it's visible on every route. */}
          {syncNotice && (
            <span role="status" style={{
              fontFamily: "'IBM Plex Mono', monospace", fontSize: "11px",
              color: "#f0a030", maxWidth: 280,
            }}>
              {syncNotice}
            </span>
          )}
        </>
  );

  const accountControl = demoMode ? (
            <button
              onClick={() => setDemoMode(false)}
              style={{
                background: "transparent", border: "1px solid #333", color: "#888",
                padding: "6px 14px", borderRadius: "4px", cursor: "pointer",
                fontSize: "11px", fontFamily: "'IBM Plex Mono', monospace",
              }}
            >
              Exit demo
            </button>
  ) : (
            <UserButton afterSignOutUrl="/" />
  );

  const header = (
    <AppHeader
      overviewActions={overviewActions}
      syncActions={syncActions}
      accountControl={accountControl}
    />
  );

  const setupPanel = (
        <div style={styles.hero as CSSProperties}>
          <h1 style={{
            ...(styles.heroTitle as CSSProperties),
            fontSize: isMobile ? "32px" : "52px",
            letterSpacing: isMobile ? "-1px" : "-2px",
          }}>Connect your<br />bank account.</h1>
          <p style={styles.heroSub as CSSProperties}>
            Node.js + React + Plaid Link integration.<br />
            Production mode — connected to Wells Fargo.
          </p>

          <div style={{
            ...(styles.stepList as CSSProperties),
            gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
          }}>
            {steps.map((s, i) => (
              <div key={i} style={(styles.step as (d: boolean) => CSSProperties)(s.done)}>
                <div style={(styles.stepDot as (d: boolean) => CSSProperties)(s.done)} />
                <span style={(styles.stepLabel as (d: boolean) => CSSProperties)(s.done)}>{s.label}</span>
              </div>
            ))}
          </div>

          {!connected ? (
            <>
              <button
                style={{
                  ...(loading.link || !ready ? styles.loadingBtn as CSSProperties : styles.connectBtn as CSSProperties),
                  ...(isMobile ? { width: "100%", padding: "14px 20px", fontSize: "15px" } : {}),
                }}
                onClick={() => open()}
                disabled={loading.link || !ready}
                onMouseOver={(e: React.MouseEvent<HTMLButtonElement>) => {
                  if (ready) e.currentTarget.style.background = "#00c98d";
                }}
                onMouseOut={(e: React.MouseEvent<HTMLButtonElement>) => {
                  if (ready) e.currentTarget.style.background = "#00e5a0";
                }}
              >
                {loading.link ? "Loading Plaid…" : "Connect Bank Account →"}
              </button>
              <p style={styles.hint as CSSProperties}>Link a new bank account via Plaid to get started.</p>
            </>
          ) : (
            <button style={{
              ...(styles.connectBtn as CSSProperties),
              background: "#1a2e20", color: "#00e5a0",
              ...(isMobile ? { width: "100%", padding: "14px 20px", fontSize: "15px" } : {}),
            }} onClick={fetchData}>
              ↻ Refresh Data
            </button>
          )}

          {error && <div style={styles.error as CSSProperties}>⚠ {error}</div>}
        </div>
  );

  const dashboard = (
    <OverviewView
      setupPanel={setupPanel}
      heroProps={heroProps}
      showHero={connected}
      hasAccounts={accounts.length > 0}
      categories={categories}
    />
  );

  // ── Demo banner — slim persistent bar shown only while in demo mode ──
  const demoBanner = (
    <div style={{
      background: "#1a2e20",
      borderBottom: "1px solid #00e5a030",
      padding: "10px 20px",
      display: "flex", alignItems: "center", justifyContent: "center",
      gap: "16px", flexWrap: "wrap",
    }}>
      <span style={{
        fontFamily: "'IBM Plex Mono', monospace", fontSize: "12px", color: "#00e5a0",
      }}>
        Demo mode — sample data, changes aren't saved.
      </span>
      <button
        onClick={() => setDemoMode(false)}
        style={{
          background: "#00e5a0", color: "#000", border: "none",
          padding: "4px 14px", borderRadius: "4px", cursor: "pointer",
          fontSize: "11px", fontWeight: 700, fontFamily: "'Syne', sans-serif",
        }}
      >
        Sign in
      </button>
    </div>
  );

  // ── Routes ───────────────────────────────────────────────────────
  // Index renders the existing dashboard completely untouched; the other four
  // tabs are empty until stage 2. Declared once and reused by both the demo
  // and signed-in branches so the two can never drift.
  // Tabs are filled in one at a time (stage 2); whatever is still empty falls
  // through to the placeholder.
  const TAB_VIEWS: Record<string, React.ReactNode> = {
    transactions: <TransactionsView />,
    accounts: <AccountsView />,
    budgets: <BudgetsView />,
    subscriptions: <SubscriptionsView />,
  };
  const [overviewTab, ...otherTabs] = TABS;
  const routes = (
    <Routes>
      <Route path={overviewTab.path} element={dashboard} />
      {otherTabs.map((tab) => (
        <Route
          key={tab.id}
          path={tab.path}
          element={TAB_VIEWS[tab.id] ?? <PlaceholderView title={tab.label} />}
        />
      ))}
      {/* An unknown in-app path is a dead end, not a 404 page — send it home.
          `replace` so Back doesn't bounce the user straight back into it. */}
      <Route path="*" element={<Navigate to={overviewTab.path} replace />} />
    </Routes>
  );

  // ── Render ───────────────────────────────────────────────────────
  // Everything app-level — demoMode + its URL/sessionStorage sync, authFetch,
  // every data fetcher, and the Clerk gate — lives above <Routes>, so route
  // changes never remount it and no route element owns shared state.
  // M7.2's period anchor belongs alongside demoMode near the top of this
  // component, for the same reason.
  let content: React.ReactNode;
  if (initialLoading) {
    content = splash;
  } else if (demoMode) {
    content = (
      <>
        {demoBanner}
        {header}
        {routes}
      </>
    );
  } else {
    content = (
      <>
        <SignedOut>
      <div style={{
        display: "flex", flexDirection: "column",
        justifyContent: "center", alignItems: "center",
        height: "100vh", background: "#0a0f0c", gap: "24px",
      }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{
            fontFamily: "Fraunces, Georgia, serif", fontWeight: 300,
            fontSize: 28, color: "#e8f4e8", letterSpacing: "-.01em",
          }}>Ledger</span>
          <span style={{
            fontFamily: "'IBM Plex Mono', monospace", fontSize: 11,
            color: "#5a7a5a", letterSpacing: ".06em",
          }}>v0.5</span>
        </div>
        <SignIn />
        <button
          onClick={() => setDemoMode(true)}
          style={{
            background: "transparent", color: "#00e5a0", border: "1px solid #00e5a040",
            padding: "10px 24px", borderRadius: "8px", cursor: "pointer",
            fontSize: "13px", fontFamily: "'IBM Plex Mono', monospace", letterSpacing: "0.3px",
          }}
        >
          View demo — no login required
        </button>
      </div>
        </SignedOut>

        <SignedIn>
          {header}
          {routes}
        </SignedIn>
      </>
    );
  }

  return (
    <DemoContext.Provider value={{ demoMode }}>
      <BrowserRouter>
        {/* Owns the `?demo=1` write, from inside the router. Rendered in every
            branch — including the splash — so the URL is correct before any
            route reads it. */}
        <DemoUrlSync demoMode={demoMode} />
        {/* SyncProvider: every view re-fetches synced data when syncVersion
            changes. AlertsProvider: one alerts source for the bell on every
            route, fetching only in demo mode or once signed in, so the splash
            and sign-in screens cost nothing. */}
        <SyncProvider version={syncVersion}>
          <AlertsProvider>
            {content}
          </AlertsProvider>
        </SyncProvider>
      </BrowserRouter>
    </DemoContext.Provider>
  );
}

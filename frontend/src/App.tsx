// ─────────────────────────────────────────────────────────────────
//  App.tsx  —  Ledger Personal Finance Dashboard
// ─────────────────────────────────────────────────────────────────

import React, { useState, useCallback, useEffect, useMemo, CSSProperties } from "react";
import { usePlaidLink, PlaidLinkOnSuccessMetadata, PlaidLinkError } from "react-plaid-link";
import SpendingChart from "./SpendingChart";
import CategoryComparison from "./CategoryComparison"
import SubscriptionTracker from "./SubscriptionTracker";
import { Account, EnrichedTransaction, CategorySpend, Budget, Alert } from "./types"
import TrendChart from './TrendChart'
import BudgetCard from './BudgetCard'
import TransactionDetail from "./TransactionDetail"
import TransactionList from "./TransactionList"
import NetWorthChart from "./NetWorthChart"
import CashFlowChart from "./CashFlowChart"
import useMediaQuery from "./useMediaQuery"
import {
  SignedIn,
  SignedOut,
  SignIn,
  UserButton,
  useAuth,
} from "@clerk/clerk-react";
import { API_URL } from "./config"
import HeroOverview from "./HeroOverview"
import InsightsDashboard from "./InsightsDashboard"
import SavingsTrend from "./SavingsTrend"
import WeeklyDigestCard from "./WeeklyDigestCard"
import AlertCenter from "./AlertCenter"
import FinancialScoreCard from "./FinancialScoreCard"
import GoalsCard from "./GoalsCard"


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
  accountGrid:  { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "16px" },
  accountCard: {
    background: "#111",
    border: "1px solid #1e1e1e",
    borderRadius: "12px",
    padding: "24px",
    position: "relative",
    overflow: "hidden",
  },
  accountType: {
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: "10px",
    color: "#555",
    textTransform: "uppercase",
    letterSpacing: "1px",
    marginBottom: "8px",
  },
  accountName:  { fontSize: "17px", fontWeight: 700, marginBottom: "4px", letterSpacing: "-0.3px" },
  accountMask:  { fontFamily: "'IBM Plex Mono', monospace", fontSize: "12px", color: "#555", marginBottom: "20px" },
  balanceRow:   { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "6px" },
  balanceLabel: { fontFamily: "'IBM Plex Mono', monospace", fontSize: "11px", color: "#555" },
  balanceValue: (highlight: boolean) => ({
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: "18px",
    fontWeight: 500,
    color: highlight ? "#00e5a0" : "#f0ede8",
  }),
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

// ── Format currency ───────────────────────────────────────────────
const fmt = (n: number | null | undefined, code = "USD") =>
  n == null
    ? "—"
    : new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(n);

// ── Component prop types ──────────────────────────────────────────
type AccountCardProps = { account: Account };

// ── Account Card ──────────────────────────────────────────────────
function AccountCard({ account }: AccountCardProps) {
  const {
    name, officialName, type, subtype,
    mask, currentBalance, availableBalance, isoCurrencyCode,
  } = account;
  const currency = isoCurrencyCode || "USD";
  return (
    <div style={styles.accountCard as CSSProperties}>
      <div style={styles.accountType as CSSProperties}>{type} · {subtype}</div>
      <div style={styles.accountName as CSSProperties}>{name}</div>
      <div style={styles.accountMask as CSSProperties}>{officialName || name} ···· {mask || "——"}</div>
      <div style={styles.balanceRow as CSSProperties}>
        <span style={styles.balanceLabel as CSSProperties}>Available</span>
        <span style={(styles.balanceValue as (h: boolean) => CSSProperties)(true)}>{fmt(availableBalance, currency)}</span>
      </div>
      <div style={styles.balanceRow as CSSProperties}>
        <span style={styles.balanceLabel as CSSProperties}>Current</span>
        <span style={(styles.balanceValue as (h: boolean) => CSSProperties)(false)}>{fmt(currentBalance, currency)}</span>
      </div>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────
export default function App() {
  const [linkToken,    setLinkToken]    = useState<string | null>(null);
  const [connected,    setConnected]    = useState(false);
  const [accounts,     setAccounts]     = useState<Account[]>([]);
  const [categories,   setCategories]   = useState<CategorySpend[]>([]);
  const [budgets,      setBudgets]      = useState<Budget[]>([]);
  const [alerts,       setAlerts]       = useState<Alert[]>([]);
  const [netWorthHistory, setNetWorthHistory] = useState<Array<{ date: string; netWorth: number }>>([]);
  const [cashFlow,        setCashFlow]        = useState<Array<{ month: string; net: number }>>([]);
  const [loading,      setLoading]      = useState({ link: true, accounts: false, tx: false });
  const [error,        setError]        = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);

  const [selectedTx, setSelectedTx] = useState<EnrichedTransaction | null>(null)

  const isMobile = useMediaQuery("(max-width: 640px)")
  const { getToken, isSignedIn, isLoaded } = useAuth();

  // ── Authenticated fetch wrapper ──────────────────────────────────
  const authFetch = useCallback(
    async (url: string, options: RequestInit = {}) => {
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
    [getToken]
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
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
    const thisMonth = cashFlow.find(c => c.month === ym)
    const monthSaved = thisMonth?.net ?? null
    const monthLabel = now.toLocaleString("en-US", { month: "long" })
    const lastSyncAt = null

    return { netWorth, netWorthMomPct, cashAvailable, debt, monthSaved, monthLabel, lastSyncAt }
  }, [accounts, netWorthHistory, cashFlow])

  // ── Auto-connect check ───────────────────────────────────────────
  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) { setInitialLoading(false); return; }

    (async () => {
      try {
        const res = await authFetch(`${API_URL}/accounts`);
        const data = await res.json() as { accounts: Account[]; error?: string };
        if (data.accounts && data.accounts.length > 0) {
          setConnected(true);
          setAccounts(data.accounts);
        }
      } catch (err) {
        console.error("Auto-connect check failed:", err);
      } finally {
        setInitialLoading(false);
      }
    })();
  }, [authFetch, isSignedIn]);

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

  // ── Fetch budgets ────────────────────────────────────────────────
  const fetchBudgets = useCallback(async () => {
    try {
      const res  = await authFetch(`${API_URL}/budgets`);
      const data = await res.json() as { budgets: Budget[] };
      setBudgets(data.budgets ?? []);
    } catch (e: any) {
      console.error("Budgets fetch failed:", e.message);
    }
  }, [authFetch]);

  // ── Fetch alerts — backend returns Alert[] directly ──────────────
  const fetchAlerts = useCallback(async () => {
    try {
      const res  = await authFetch(`${API_URL}/alerts`)
      const data = await res.json() as Alert[]
      setAlerts(Array.isArray(data) ? data : [])
    } catch (e: any) {
      console.error("Alerts fetch failed:", e.message)
    }
  }, [authFetch])

  const fetchNetWorth = useCallback(async () => {
    try {
      const res  = await authFetch(`${API_URL}/networth`)
      const data = await res.json() as { history?: Array<{ date: string; netWorth: number }> }
      setNetWorthHistory(data.history ?? [])
    } catch (e: any) {
      console.error("Net worth fetch failed:", e.message)
    }
  }, [authFetch])

  const fetchCashFlow = useCallback(async () => {
    try {
      const res  = await authFetch(`${API_URL}/cashflow`)
      const data = await res.json() as { cashFlow?: Array<{ month: string; net: number }> }
      setCashFlow(data.cashFlow ?? [])
    } catch (e: any) {
      console.error("Cash flow fetch failed:", e.message)
    }
  }, [authFetch])

  // ── Fetch all dashboard data ─────────────────────────────────────
  const fetchData = useCallback(async () => {
    setLoading((l) => ({ ...l, accounts: true }));

    try {
      const res  = await authFetch(`${API_URL}/accounts`);
      const data = await res.json() as { accounts: Account[]; error?: string };
      if (data.error) throw new Error(data.error);
      setAccounts(data.accounts);
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

    fetchBudgets();
  }, [authFetch, fetchBudgets]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    fetchData();
    fetchBudgets();
    fetchAlerts();
    fetchNetWorth();
    fetchCashFlow();
  }, [fetchData, fetchBudgets, fetchAlerts, fetchNetWorth, fetchCashFlow, isSignedIn])

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
  if (initialLoading) {
    return (
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
  }

  return (
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
      </div>
    </SignedOut>

    <SignedIn>
    <div style={styles.root as CSSProperties}>
      <header style={{
        ...(styles.header as CSSProperties),
        padding: isMobile ? "16px 20px" : "24px 40px",
      }}>
        {/* Word-mark */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{
            fontFamily: "Fraunces, Georgia, serif", fontWeight: 300,
            fontSize: 22, color: "#e8f4e8", letterSpacing: "-.01em",
          }}>Ledger</span>
          <span style={{
            fontFamily: "'IBM Plex Mono', monospace", fontSize: 10,
            color: "#5a7a5a", letterSpacing: ".06em",
          }}>v0.5</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          {connected && (
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
          )}
          <UserButton afterSignOutUrl="/" />
        </div>
      </header>

      <main style={{
        ...(styles.main as CSSProperties),
        padding: isMobile ? "30px 16px" : "60px 40px",
      }}>
        {connected && <HeroOverview {...heroProps} />}

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

        {/* Weekly Digest + Smart Alerts (M5.8) */}
        {accounts.length > 0 && (
          <div style={styles.section as CSSProperties}>
            <WeeklyDigestCard />
            <div style={{ marginTop: 24 }}>
              <div style={styles.sectionHeader as CSSProperties}>
                <h2 style={styles.sectionTitle as CSSProperties}>Alerts</h2>
                <span style={styles.sectionCount as CSSProperties}>
                  {alerts.filter(a => !a.dismissedAt).length} active
                </span>
              </div>
              <AlertCenter />
            </div>
          </div>
        )}

        {/* Account Balances */}
        {accounts.length > 0 && (
          <div style={styles.section as CSSProperties}>
            <div style={styles.sectionHeader as CSSProperties}>
              <h2 style={styles.sectionTitle as CSSProperties}>Account Balances</h2>
              <span style={styles.sectionCount as CSSProperties}>{accounts.length} accounts</span>
            </div>
            <div style={{
              ...(styles.accountGrid as CSSProperties),
              gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill, minmax(260px, 1fr))",
            }}>
              {accounts.map((a) => <AccountCard key={a.plaidAccountId} account={a} />)}
            </div>
          </div>
        )}

        {/* Financial Insights */}
        {accounts.length > 0 && (
          <section style={{ marginBottom: 32 }}>
            <InsightsDashboard />
          </section>
        )}

        {/* Spending Breakdown + Month-over-Month */}
        {accounts.length > 0 && (
          <div style={styles.section as CSSProperties}>
            <section style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr" : "1.4fr 1fr",
              gap: 24, marginBottom: 32,
            }}>
              <div style={{ background: "#161e14", border: "1px solid #253325", borderRadius: 10, padding: 20 }}>
                <h3 style={{ fontFamily: "Fraunces, Georgia, serif", fontWeight: 300, fontSize: 18, color: "#e8f4e8", marginBottom: 16 }}>
                  Spending breakdown
                </h3>
                <SpendingChart data={categories} />
              </div>
              <div style={{ background: "#161e14", border: "1px solid #253325", borderRadius: 10, padding: 20 }}>
                <h3 style={{ fontFamily: "Fraunces, Georgia, serif", fontWeight: 300, fontSize: 18, color: "#e8f4e8", marginBottom: 16 }}>
                  Month over month
                </h3>
                <CategoryComparison />
              </div>
            </section>
          </div>
        )}

        {/* Monthly Spending Trend */}
        {accounts.length > 0 && (
          <div style={styles.section as CSSProperties}>
            <div style={styles.sectionHeader as CSSProperties}>
              <h2 style={styles.sectionTitle as CSSProperties}>Monthly Spending</h2>
              <span style={styles.sectionCount as CSSProperties}>last 12 months</span>
            </div>
            <TrendChart />
          </div>
        )}

        {/* Financial Score + Goals (M5.9) */}
        {accounts.length > 0 && (
          <section style={{
            display: "grid",
            gridTemplateColumns: isMobile ? "1fr" : "1fr 1.2fr",
            gap: 24, marginBottom: 32,
          }}>
            <FinancialScoreCard />
            <div style={{
              background: "#161e14", border: "1px solid #253325",
              borderRadius: 10, padding: 20,
            }}>
              <h3 style={{
                fontFamily: "Fraunces, Georgia, serif", fontWeight: 300,
                fontSize: 18, color: "#e8f4e8", marginBottom: 16,
              }}>Goals</h3>
              <GoalsCard />
            </div>
          </section>
        )}

        {/* Net Worth */}
        {accounts.length > 0 && (
          <div style={styles.section as CSSProperties}>
            <div style={styles.sectionHeader as CSSProperties}>
              <h2 style={styles.sectionTitle as CSSProperties}>Net Worth</h2>
            </div>
            <NetWorthChart />
          </div>
        )}

        {/* Cash Flow + Savings Trend */}
        {accounts.length > 0 && (
          <div style={styles.section as CSSProperties}>
            <div style={styles.sectionHeader as CSSProperties}>
              <h2 style={styles.sectionTitle as CSSProperties}>Cash Flow</h2>
              <span style={styles.sectionCount as CSSProperties}>last 6 months</span>
            </div>
            <section style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr" : "1.4fr 1fr",
              gap: 24, marginBottom: 32,
            }}>
              <div style={{ background: "#161e14", border: "1px solid #253325", borderRadius: 10, padding: 20 }}>
                <h3 style={{ fontFamily: "Fraunces, Georgia, serif", fontWeight: 300, fontSize: 18, color: "#e8f4e8", marginBottom: 16 }}>Cash flow</h3>
                <CashFlowChart />
              </div>
              <div style={{ background: "#161e14", border: "1px solid #253325", borderRadius: 10, padding: 20 }}>
                <h3 style={{ fontFamily: "Fraunces, Georgia, serif", fontWeight: 300, fontSize: 18, color: "#e8f4e8", marginBottom: 16 }}>Monthly savings</h3>
                <SavingsTrend />
              </div>
            </section>
          </div>
        )}

        {/* Monthly Budgets */}
        {budgets.length > 0 && (
          <div style={styles.section as CSSProperties}>
            <div style={styles.sectionHeader as CSSProperties}>
              <h2 style={styles.sectionTitle as CSSProperties}>Monthly Budgets</h2>
              <span style={styles.sectionCount as CSSProperties}>this month</span>
            </div>
            {budgets.map((b) => (
              <BudgetCard key={b.category} budget={b} onUpdated={fetchBudgets} />
            ))}
          </div>
        )}

        {/* Recurring & Subscriptions */}
        {accounts.length > 0 && (
          <div style={styles.section as CSSProperties}>
            <div style={styles.sectionHeader as CSSProperties}>
              <h2 style={styles.sectionTitle as CSSProperties}>Subscriptions & Bills</h2>
              <span style={styles.sectionCount as CSSProperties}>subscriptions &amp; recurring bills</span>
            </div>
            <SubscriptionTracker />
          </div>
        )}

        {/* Transactions */}
        {accounts.length > 0 && (
          <div style={styles.section as CSSProperties}>
            <div style={styles.sectionHeader as CSSProperties}>
              <h2 style={styles.sectionTitle as CSSProperties}>Transactions</h2>
            </div>
            <TransactionList onRowClick={tx => setSelectedTx(tx)} />
          </div>
        )}
      </main>
    </div>

    {selectedTx && (
      <TransactionDetail
        transaction={selectedTx}
        onClose={() => setSelectedTx(null)}
        onUpdate={updated => setSelectedTx(updated)}
      />
    )}

    </SignedIn>
    </>
  );
}

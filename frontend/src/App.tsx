// ─────────────────────────────────────────────────────────────────
//  App.tsx  —  Plaid Integration Frontend
// ─────────────────────────────────────────────────────────────────

import React, { useState, useCallback, useEffect, useMemo, CSSProperties } from "react";
import { usePlaidLink, PlaidLinkOnSuccessMetadata, PlaidLinkError } from "react-plaid-link";
import SpendingChart from "./SpendingChart";
import RecurringCard from "./RecurringCard";
import { Account, Transaction, CategorySpend } from "./types";
import TrendChart from './TrendChart'

const API     = "https://finance-dashboard-production-1a0c.up.railway.app";
const USER_ID = "demo-user";

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
  logo:       { fontSize: "20px", fontWeight: 800, letterSpacing: "-0.5px", color: "#f0ede8" },
  logoAccent: { color: "#00e5a0" },
  envBadge: {
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: "11px",
    background: "#1a2e20",
    color: "#00e5a0",
    padding: "4px 10px",
    borderRadius: "4px",
    border: "1px solid #00e5a020",
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
  hintAccent: { color: "#00e5a080" },
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
  txTable: { width: "100%", borderCollapse: "collapse" },
  txHead: {
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: "10px",
    color: "#555",
    textTransform: "uppercase",
    letterSpacing: "1px",
    textAlign: "left",
    padding: "8px 12px",
    borderBottom: "1px solid #1a1a1a",
  },
  txRow:   (i: number) => ({ borderBottom: "1px solid #111", background: i % 2 === 0 ? "transparent" : "#0d0d0d" }),
  txCell:  { padding: "10px 12px", fontSize: "13px", fontFamily: "'IBM Plex Mono', monospace", color: "#888" },
  txName:  { padding: "10px 12px", fontSize: "14px", fontWeight: 600, color: "#d0cdc8" },
  txAmount: (amount: number) => ({
    padding: "10px 12px",
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: "14px",
    fontWeight: 500,
    color: amount > 0 ? "#ff6b6b" : "#00e5a0",
    textAlign: "right",
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
  pending: {
    display: "inline-block",
    background: "#1a1500",
    color: "#ffb347",
    fontSize: "10px",
    fontFamily: "'IBM Plex Mono', monospace",
    padding: "2px 6px",
    borderRadius: "3px",
    marginLeft: "6px",
  },
  tag: {
    display: "inline-block",
    background: "#1a1a2e",
    color: "#7b9fff",
    fontSize: "10px",
    fontFamily: "'IBM Plex Mono', monospace",
    padding: "2px 7px",
    borderRadius: "3px",
  },
  filterBar: {
    display: "flex",
    gap: "10px",
    flexWrap: "wrap",
    alignItems: "center",
    marginBottom: "20px",
    padding: "14px 16px",
    background: "#111",
    border: "1px solid #1e1e1e",
    borderRadius: "10px",
  },
  filterInput: {
    background: "#0d0d0d",
    border: "1px solid #222",
    borderRadius: "6px",
    padding: "7px 12px",
    color: "#f0ede8",
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: "12px",
    width: "200px",
    outline: "none",
  },
  filterSelect: {
    background: "#0d0d0d",
    border: "1px solid #222",
    borderRadius: "6px",
    padding: "7px 10px",
    color: "#f0ede8",
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: "12px",
    outline: "none",
    cursor: "pointer",
  },
  filterBtn: (active: boolean) => ({
    background: active ? "#00e5a0" : "#0d0d0d",
    border: `1px solid ${active ? "#00e5a0" : "#222"}`,
    borderRadius: "6px",
    padding: "7px 12px",
    color: active ? "#000" : "#888",
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: "11px",
    cursor: "pointer",
    transition: "all 0.15s",
    fontWeight: active ? 600 : 400,
  }),
  clearBtn: {
    background: "transparent",
    border: "1px solid #333",
    borderRadius: "6px",
    padding: "7px 12px",
    color: "#555",
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: "11px",
    cursor: "pointer",
    marginLeft: "auto",
  },
  filterCount: {
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: "11px",
    color: "#555",
  },
};

// ── Format currency ───────────────────────────────────────────────
const fmt = (n: number | null | undefined, code = "USD") =>
  n == null
    ? "—"
    : new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(n);

// ── Format date ───────────────────────────────────────────────────
const fmtDate = (d: string | null | undefined) => (d ? String(d).slice(0, 10) : "—");

// ── Component prop types ──────────────────────────────────────────
type AccountCardProps = { account: Account };

type TxRowProps = { tx: Transaction; index: number };

type FilterBarProps = {
  searchInput:       string;
  setSearchInput:    React.Dispatch<React.SetStateAction<string>>;
  dateRange:         number | null;
  setDateRange:      React.Dispatch<React.SetStateAction<number | null>>;
  categoryFilter:    string;
  setCategoryFilter: React.Dispatch<React.SetStateAction<string>>;
  sortBy:            string;
  setSortBy:         React.Dispatch<React.SetStateAction<string>>;
  uniqueCategories:  string[];
  onClear:           () => void;
  totalCount:        number;
  filteredCount:     number;
};

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

// ── Transaction Row ───────────────────────────────────────────────
function TxRow({ tx, index }: TxRowProps) {
  return (
    <tr style={(styles.txRow as (i: number) => CSSProperties)(index)}>
      <td style={styles.txCell as CSSProperties}>{fmtDate(tx.date)}</td>
      <td style={styles.txName as CSSProperties}>
        {tx.merchantName || tx.name}
        {tx.pending && <span style={styles.pending as CSSProperties}>pending</span>}
      </td>
      <td style={styles.txCell as CSSProperties}>
        {tx.categoryPrimary && (
          <span style={styles.tag as CSSProperties}>{tx.categoryPrimary.replace(/_/g, " ")}</span>
        )}
      </td>
      <td style={(styles.txAmount as (a: number) => CSSProperties)(tx.amount)}>
        {tx.amount > 0 ? "-" : "+"}
        {fmt(Math.abs(tx.amount), tx.isoCurrencyCode || "USD")}
      </td>
    </tr>
  );
}

// ── Filter Bar ────────────────────────────────────────────────────
function FilterBar({
  searchInput, setSearchInput, dateRange, setDateRange,
  categoryFilter, setCategoryFilter, sortBy, setSortBy,
  uniqueCategories, onClear, totalCount, filteredCount,
}: FilterBarProps) {
  return (
    <div style={styles.filterBar as CSSProperties}>
      <input
        style={styles.filterInput as CSSProperties}
        placeholder="Search merchants…"
        value={searchInput}
        onChange={(e) => setSearchInput(e.target.value)}
      />
      {[7, 30, 90, null].map((d) => (
        <button
          key={d ?? "all"}
          style={(styles.filterBtn as (a: boolean) => CSSProperties)(dateRange === d)}
          onClick={() => setDateRange(d)}
        >
          {d ? `${d}d` : "All"}
        </button>
      ))}
      <select style={styles.filterSelect as CSSProperties} value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
        <option value="">All categories</option>
        {uniqueCategories.map((cat: string) => (
          <option key={cat} value={cat}>{cat.replace(/_/g, " ")}</option>
        ))}
      </select>
      <select style={styles.filterSelect as CSSProperties} value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
        <option value="date-desc">Newest first</option>
        <option value="date-asc">Oldest first</option>
        <option value="amount-desc">Highest amount</option>
        <option value="amount-asc">Lowest amount</option>
      </select>
      <span style={styles.filterCount as CSSProperties}>{filteredCount} / {totalCount}</span>
      <button style={styles.clearBtn as CSSProperties} onClick={onClear}>✕ Clear</button>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────
export default function App() {
  const [linkToken,    setLinkToken]    = useState<string | null>(null);
  const [connected,    setConnected]    = useState(false);
  const [accounts,     setAccounts]     = useState<Account[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [categories,   setCategories]   = useState<CategorySpend[]>([]);
  const [loading,      setLoading]      = useState({ link: true, accounts: false, tx: false });
  const [error,        setError]        = useState<string | null>(null);

  // ── Filter state ────────────────────────────────────────────────
  const [searchInput,    setSearchInput]    = useState("");
  const [search,         setSearch]         = useState("");
  const [dateRange,      setDateRange]      = useState<number | null>(30);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [sortBy,         setSortBy]         = useState("date-desc");

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const filteredTransactions = useMemo(() => {
    let result = [...transactions];
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((tx) => (tx.merchantName || tx.name || "").toLowerCase().includes(q));
    }
    if (dateRange) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - dateRange);
      result = result.filter((tx) => new Date(tx.date) >= cutoff);
    }
    if (categoryFilter) result = result.filter((tx) => tx.categoryPrimary === categoryFilter);
    result.sort((a, b) => {
      if (sortBy === "date-desc")   return new Date(b.date).getTime() - new Date(a.date).getTime();
      if (sortBy === "date-asc")    return new Date(a.date).getTime() - new Date(b.date).getTime();
      if (sortBy === "amount-desc") return b.amount - a.amount;
      if (sortBy === "amount-asc")  return a.amount - b.amount;
      return 0;
    });
    return result;
  }, [transactions, search, dateRange, categoryFilter, sortBy]);

  const uniqueCategories = useMemo(
    () => [...new Set(transactions.map((tx) => tx.categoryPrimary).filter(Boolean))] as string[],
    [transactions]
  );

  // Fetch link_token on mount
  useEffect(() => {
    (async () => {
      try {
        const res  = await fetch(`${API}/create_link_token`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: USER_ID }),
        });
        const data = await res.json() as { link_token: string; error?: string };
        if (data.error) throw new Error(data.error);
        setLinkToken(data.link_token);
      } catch (e: any) {
        setError(`Failed to get link token: ${e.message}`);
      } finally {
        setLoading((l) => ({ ...l, link: false }));
      }
    })();
  }, []);

  // Fetch accounts + transactions + categories
  const fetchData = useCallback(async () => {
    setLoading((l) => ({ ...l, accounts: true, tx: true }));

    try {
      const res  = await fetch(`${API}/accounts`);
      const data = await res.json() as { accounts: Account[]; error?: string };
      if (data.error) throw new Error(data.error);
      setAccounts(data.accounts);
    } catch (e: any) {
      setError(`Accounts fetch failed: ${e.message}`);
    } finally {
      setLoading((l) => ({ ...l, accounts: false }));
    }

    try {
      const res  = await fetch(`${API}/transactions`);
      const data = await res.json() as { transactions: Transaction[]; error?: string };
      if (data.error) throw new Error(data.error);
      setTransactions(data.transactions);
    } catch (e: any) {
      setError(`Transactions fetch failed: ${e.message}`);
    } finally {
      setLoading((l) => ({ ...l, tx: false }));
    }

    try {
      const res  = await fetch(`${API}/categories`);
      const data = await res.json() as { categories: CategorySpend[]; error?: string };
      if (data.error) throw new Error(data.error);
      setCategories(data.categories || []);
    } catch (e: any) {
      setError(`Categories fetch failed: ${e.message}`);
    }
  }, []);

  const onSuccess = useCallback(
    async (public_token: string, metadata: PlaidLinkOnSuccessMetadata) => {
      console.log("✅ Plaid Link success!", metadata.institution);
      try {
        const res  = await fetch(`${API}/exchange_public_token`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ public_token, userId: USER_ID }),
        });
        const data = await res.json() as { error?: string };
        if (data.error) throw new Error(data.error);
        setConnected(true);
        fetchData();
      } catch (e: any) {
        setError(`Token exchange failed: ${e.message}`);
      }
    },
    [fetchData]
  );

  const clearFilters = useCallback(() => {
    setSearchInput(""); setSearch(""); setDateRange(30);
    setCategoryFilter(""); setSortBy("date-desc");
  }, []);

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
    { label: "transactions fetched",  done: transactions.length > 0 },
  ];

  return (
    <div style={styles.root as CSSProperties}>
      <header style={styles.header as CSSProperties}>
        <div style={styles.logo as CSSProperties}>plaid<span style={styles.logoAccent as CSSProperties}>.</span>app</div>
        <div style={styles.envBadge as CSSProperties}>ENV: SANDBOX</div>
      </header>

      <main style={styles.main as CSSProperties}>
        <div style={styles.hero as CSSProperties}>
          <h1 style={styles.heroTitle as CSSProperties}>Connect your<br />bank account.</h1>
          <p style={styles.heroSub as CSSProperties}>
            Node.js + React + Plaid Link integration.<br />
            Sandbox mode — use Wells Fargo test credentials.
          </p>

          <div style={styles.stepList as CSSProperties}>
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
                style={loading.link || !ready ? styles.loadingBtn as CSSProperties : styles.connectBtn as CSSProperties}
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
              <p style={styles.hint as CSSProperties}>
                In the Plaid Link dialog, select{" "}
                <span style={styles.hintAccent as CSSProperties}>Wells Fargo</span> and use sandbox credentials:{" "}
                <span style={styles.hintAccent as CSSProperties}>user_good</span> / <span style={styles.hintAccent as CSSProperties}>pass_good</span>
              </p>
            </>
          ) : (
            <button style={{ ...(styles.connectBtn as CSSProperties), background: "#1a2e20", color: "#00e5a0" }} onClick={fetchData}>
              ↻ Refresh Data
            </button>
          )}

          {error && <div style={styles.error as CSSProperties}>⚠ {error}</div>}
        </div>

        {/* Account Balances */}
        {accounts.length > 0 && (
          <div style={styles.section as CSSProperties}>
            <div style={styles.sectionHeader as CSSProperties}>
              <h2 style={styles.sectionTitle as CSSProperties}>Account Balances</h2>
              <span style={styles.sectionCount as CSSProperties}>{accounts.length} accounts</span>
            </div>
            <div style={styles.accountGrid as CSSProperties}>
              {accounts.map((a) => <AccountCard key={a.plaidAccountId} account={a} />)}
            </div>
          </div>
        )}

        {/* Spending Breakdown */}
        {accounts.length > 0 && (
          <div style={styles.section as CSSProperties}>
            <div style={styles.sectionHeader as CSSProperties}>
              <h2 style={styles.sectionTitle as CSSProperties}>Spending Breakdown</h2>
              <span style={styles.sectionCount as CSSProperties}>by category</span>
            </div>
            <SpendingChart categories={categories} />
          </div>
        )}

{accounts.length > 0 && (
  <div style={styles.section as CSSProperties}>
    <div style={styles.sectionHeader as CSSProperties}>
      <h2 style={styles.sectionTitle as CSSProperties}>Monthly Spending</h2>
      <span style={styles.sectionCount as CSSProperties}>last 12 months</span>
    </div>
    <TrendChart />
  </div>
)}

        {/* Recurring — key={accounts.length} forces remount when accounts load */}
        {accounts.length > 0 && (
          <div style={styles.section as CSSProperties}>
            <div style={styles.sectionHeader as CSSProperties}>
              <h2 style={styles.sectionTitle as CSSProperties}>Recurring</h2>
              <span style={styles.sectionCount as CSSProperties}>subscriptions &amp; income</span>
            </div>
            <RecurringCard key={accounts.length} />
          </div>
        )}

        {/* Transactions */}
        {transactions.length > 0 && (
          <div style={styles.section as CSSProperties}>
            <div style={styles.sectionHeader as CSSProperties}>
              <h2 style={styles.sectionTitle as CSSProperties}>Transactions</h2>
              <span style={styles.sectionCount as CSSProperties}>
                {filteredTransactions.length} of {transactions.length} · last {dateRange ?? "all"} days
              </span>
            </div>
            <FilterBar
              searchInput={searchInput}       setSearchInput={setSearchInput}
              dateRange={dateRange}           setDateRange={setDateRange}
              categoryFilter={categoryFilter} setCategoryFilter={setCategoryFilter}
              sortBy={sortBy}                 setSortBy={setSortBy}
              uniqueCategories={uniqueCategories}
              onClear={clearFilters}
              totalCount={transactions.length}
              filteredCount={filteredTransactions.length}
            />
            {filteredTransactions.length === 0 ? (
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "13px", color: "#555", padding: "20px 0" }}>
                No transactions match your filters.
              </div>
            ) : (
              <table style={styles.txTable as CSSProperties}>
                <thead>
                  <tr>
                    <th style={styles.txHead as CSSProperties}>Date</th>
                    <th style={styles.txHead as CSSProperties}>Name</th>
                    <th style={styles.txHead as CSSProperties}>Category</th>
                    <th style={{ ...(styles.txHead as CSSProperties), textAlign: "right" }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTransactions.map((tx, i) => (
                    <TxRow key={tx.plaidTransactionId} tx={tx} index={i} />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
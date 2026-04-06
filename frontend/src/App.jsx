// ─────────────────────────────────────────────────────────────────
//  App.jsx  —  Plaid Integration Frontend
// ─────────────────────────────────────────────────────────────────

import React, { useState, useCallback, useEffect, useMemo } from "react";
import { usePlaidLink } from "react-plaid-link";
import SpendingChart from "./SpendingChart";
import RecurringCard from "./RecurringCard";

const API     = "https://finance-dashboard-production-1a0c.up.railway.app";
const USER_ID = "demo-user";

// ── Styles ────────────────────────────────────────────────────────
const styles = {
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
  step: (done) => ({
    padding: "14px 18px",
    border: `1px solid ${done ? "#00e5a030" : "#222"}`,
    borderRadius: "8px",
    background: done ? "#0d1f15" : "#111",
    display: "flex",
    alignItems: "center",
    gap: "12px",
    transition: "all 0.3s",
  }),
  stepDot: (done) => ({
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    background: done ? "#00e5a0" : "#333",
    flexShrink: 0,
    transition: "all 0.3s",
    boxShadow: done ? "0 0 8px #00e5a080" : "none",
  }),
  stepLabel: (done) => ({
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
  balanceValue: (highlight) => ({
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
  txRow:   (i) => ({ borderBottom: "1px solid #111", background: i % 2 === 0 ? "transparent" : "#0d0d0d" }),
  txCell:  { padding: "10px 12px", fontSize: "13px", fontFamily: "'IBM Plex Mono', monospace", color: "#888" },
  txName:  { padding: "10px 12px", fontSize: "14px", fontWeight: 600, color: "#d0cdc8" },
  txAmount: (amount) => ({
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
  filterBtn: (active) => ({
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
const fmt = (n, code = "USD") =>
  n == null
    ? "—"
    : new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(n);

// ── Format date ───────────────────────────────────────────────────
const fmtDate = (d) => (d ? String(d).slice(0, 10) : "—");

// ── Account Card ──────────────────────────────────────────────────
function AccountCard({ account }) {
  const {
    name, officialName, type, subtype,
    mask, currentBalance, availableBalance, isoCurrencyCode,
  } = account;
  const currency = isoCurrencyCode || "USD";
  return (
    <div style={styles.accountCard}>
      <div style={styles.accountType}>{type} · {subtype}</div>
      <div style={styles.accountName}>{name}</div>
      <div style={styles.accountMask}>{officialName || name} ···· {mask || "——"}</div>
      <div style={styles.balanceRow}>
        <span style={styles.balanceLabel}>Available</span>
        <span style={styles.balanceValue(true)}>{fmt(availableBalance, currency)}</span>
      </div>
      <div style={styles.balanceRow}>
        <span style={styles.balanceLabel}>Current</span>
        <span style={styles.balanceValue(false)}>{fmt(currentBalance, currency)}</span>
      </div>
    </div>
  );
}

// ── Transaction Row ───────────────────────────────────────────────
function TxRow({ tx, index }) {
  return (
    <tr style={styles.txRow(index)}>
      <td style={styles.txCell}>{fmtDate(tx.date)}</td>
      <td style={styles.txName}>
        {tx.merchantName || tx.name}
        {tx.pending && <span style={styles.pending}>pending</span>}
      </td>
      <td style={styles.txCell}>
        {tx.categoryPrimary && (
          <span style={styles.tag}>{tx.categoryPrimary.replace(/_/g, " ")}</span>
        )}
      </td>
      <td style={styles.txAmount(tx.amount)}>
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
}) {
  return (
    <div style={styles.filterBar}>
      <input
        style={styles.filterInput}
        placeholder="Search merchants…"
        value={searchInput}
        onChange={(e) => setSearchInput(e.target.value)}
      />
      {[7, 30, 90, null].map((d) => (
        <button key={d ?? "all"} style={styles.filterBtn(dateRange === d)} onClick={() => setDateRange(d)}>
          {d ? `${d}d` : "All"}
        </button>
      ))}
      <select style={styles.filterSelect} value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
        <option value="">All categories</option>
        {uniqueCategories.map((cat) => (
          <option key={cat} value={cat}>{cat.replace(/_/g, " ")}</option>
        ))}
      </select>
      <select style={styles.filterSelect} value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
        <option value="date-desc">Newest first</option>
        <option value="date-asc">Oldest first</option>
        <option value="amount-desc">Highest amount</option>
        <option value="amount-asc">Lowest amount</option>
      </select>
      <span style={styles.filterCount}>{filteredCount} / {totalCount}</span>
      <button style={styles.clearBtn} onClick={onClear}>✕ Clear</button>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────
export default function App() {
  const [linkToken,    setLinkToken]    = useState(null);
  const [connected,    setConnected]    = useState(false);
  const [accounts,     setAccounts]     = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [categories,   setCategories]   = useState([]);
  const [loading,      setLoading]      = useState({ link: true, accounts: false, tx: false });
  const [error,        setError]        = useState(null);

  // ── Filter state ────────────────────────────────────────────────
  const [searchInput,    setSearchInput]    = useState("");
  const [search,         setSearch]         = useState("");
  const [dateRange,      setDateRange]      = useState(30);
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
      if (sortBy === "date-desc")   return new Date(b.date) - new Date(a.date);
      if (sortBy === "date-asc")    return new Date(a.date) - new Date(b.date);
      if (sortBy === "amount-desc") return b.amount - a.amount;
      if (sortBy === "amount-asc")  return a.amount - b.amount;
      return 0;
    });
    return result;
  }, [transactions, search, dateRange, categoryFilter, sortBy]);

  const uniqueCategories = useMemo(
    () => [...new Set(transactions.map((tx) => tx.categoryPrimary).filter(Boolean))].sort(),
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
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        setLinkToken(data.link_token);
      } catch (e) {
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
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setAccounts(data.accounts);
    } catch (e) {
      setError(`Accounts fetch failed: ${e.message}`);
    } finally {
      setLoading((l) => ({ ...l, accounts: false }));
    }

    try {
      const res  = await fetch(`${API}/transactions`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setTransactions(data.transactions);
    } catch (e) {
      setError(`Transactions fetch failed: ${e.message}`);
    } finally {
      setLoading((l) => ({ ...l, tx: false }));
    }

    try {
      const res  = await fetch(`${API}/categories`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setCategories(data.categories || []);
    } catch (e) {
      setError(`Categories fetch failed: ${e.message}`);
    }
  }, []);

  const onSuccess = useCallback(
    async (public_token, metadata) => {
      console.log("✅ Plaid Link success!", metadata.institution);
      try {
        const res  = await fetch(`${API}/exchange_public_token`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ public_token, userId: USER_ID }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        setConnected(true);
        fetchData();
      } catch (e) {
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
    token: linkToken, onSuccess,
    onExit: (err) => { if (err) setError(`Plaid Link exited with error: ${err.message}`); },
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
    <div style={styles.root}>
      <header style={styles.header}>
        <div style={styles.logo}>plaid<span style={styles.logoAccent}>.</span>app</div>
        <div style={styles.envBadge}>ENV: SANDBOX</div>
      </header>

      <main style={styles.main}>
        <div style={styles.hero}>
          <h1 style={styles.heroTitle}>Connect your<br />bank account.</h1>
          <p style={styles.heroSub}>
            Node.js + React + Plaid Link integration.<br />
            Sandbox mode — use Wells Fargo test credentials.
          </p>

          <div style={styles.stepList}>
            {steps.map((s, i) => (
              <div key={i} style={styles.step(s.done)}>
                <div style={styles.stepDot(s.done)} />
                <span style={styles.stepLabel(s.done)}>{s.label}</span>
              </div>
            ))}
          </div>

          {!connected ? (
            <>
              <button
                style={loading.link || !ready ? styles.loadingBtn : styles.connectBtn}
                onClick={() => open()}
                disabled={loading.link || !ready}
                onMouseOver={(e) => { if (ready) e.target.style.background = "#00c98d"; }}
                onMouseOut={(e)  => { if (ready) e.target.style.background = "#00e5a0"; }}
              >
                {loading.link ? "Loading Plaid…" : "Connect Bank Account →"}
              </button>
              <p style={styles.hint}>
                In the Plaid Link dialog, select{" "}
                <span style={styles.hintAccent}>Wells Fargo</span> and use sandbox credentials:{" "}
                <span style={styles.hintAccent}>user_good</span> / <span style={styles.hintAccent}>pass_good</span>
              </p>
            </>
          ) : (
            <button style={{ ...styles.connectBtn, background: "#1a2e20", color: "#00e5a0" }} onClick={fetchData}>
              ↻ Refresh Data
            </button>
          )}

          {error && <div style={styles.error}>⚠ {error}</div>}
        </div>

        {/* Account Balances */}
        {accounts.length > 0 && (
          <div style={styles.section}>
            <div style={styles.sectionHeader}>
              <h2 style={styles.sectionTitle}>Account Balances</h2>
              <span style={styles.sectionCount}>{accounts.length} accounts</span>
            </div>
            <div style={styles.accountGrid}>
              {accounts.map((a) => <AccountCard key={a.plaidAccountId} account={a} />)}
            </div>
          </div>
        )}

        {/* Spending Breakdown */}
        {accounts.length > 0 && (
          <div style={styles.section}>
            <div style={styles.sectionHeader}>
              <h2 style={styles.sectionTitle}>Spending Breakdown</h2>
              <span style={styles.sectionCount}>by category</span>
            </div>
            <SpendingChart categories={categories} />
          </div>
        )}

        {/* Recurring — key={accounts.length} forces remount when accounts load */}
        {accounts.length > 0 && (
          <div style={styles.section}>
            <div style={styles.sectionHeader}>
              <h2 style={styles.sectionTitle}>Recurring</h2>
              <span style={styles.sectionCount}>subscriptions &amp; income</span>
            </div>
            <RecurringCard key={accounts.length} />
          </div>
        )}

        {/* Transactions */}
        {transactions.length > 0 && (
          <div style={styles.section}>
            <div style={styles.sectionHeader}>
              <h2 style={styles.sectionTitle}>Transactions</h2>
              <span style={styles.sectionCount}>
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
              <table style={styles.txTable}>
                <thead>
                  <tr>
                    <th style={styles.txHead}>Date</th>
                    <th style={styles.txHead}>Name</th>
                    <th style={styles.txHead}>Category</th>
                    <th style={{ ...styles.txHead, textAlign: "right" }}>Amount</th>
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

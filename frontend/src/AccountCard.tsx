import { CSSProperties } from "react"
import type { Account } from "./types"

// Moved out of App.tsx unchanged in M7.1 stage 2; only the Accounts tab renders it.

const styles: Record<string, CSSProperties> = {
  card: {
    background: "#111",
    border: "1px solid #1e1e1e",
    borderRadius: "12px",
    padding: "24px",
    position: "relative",
    overflow: "hidden",
  },
  type: {
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: "10px",
    color: "#555",
    textTransform: "uppercase",
    letterSpacing: "1px",
    marginBottom: "8px",
  },
  name: { fontSize: "17px", fontWeight: 700, marginBottom: "4px", letterSpacing: "-0.3px" },
  mask: { fontFamily: "'IBM Plex Mono', monospace", fontSize: "12px", color: "#555", marginBottom: "20px" },
  balanceRow: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "6px" },
  balanceLabel: { fontFamily: "'IBM Plex Mono', monospace", fontSize: "11px", color: "#555" },
}

const balanceValue = (highlight: boolean): CSSProperties => ({
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: "18px",
  fontWeight: 500,
  color: highlight ? "#00e5a0" : "#f0ede8",
})

const fmt = (n: number | null | undefined, code = "USD") =>
  n == null
    ? "—"
    : new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(n)

export default function AccountCard({ account }: { account: Account }) {
  const {
    name, officialName, type, subtype,
    mask, currentBalance, availableBalance, isoCurrencyCode,
  } = account
  const currency = isoCurrencyCode || "USD"
  return (
    <div style={styles.card}>
      <div style={styles.type}>{type} · {subtype}</div>
      <div style={styles.name}>{name}</div>
      <div style={styles.mask}>{officialName || name} ···· {mask || "——"}</div>
      <div style={styles.balanceRow}>
        <span style={styles.balanceLabel}>Available</span>
        <span style={balanceValue(true)}>{fmt(availableBalance, currency)}</span>
      </div>
      <div style={styles.balanceRow}>
        <span style={styles.balanceLabel}>Current</span>
        <span style={balanceValue(false)}>{fmt(currentBalance, currency)}</span>
      </div>
    </div>
  )
}

import React from "react"

interface Props {
  merchants: Array<{ merchant: string; total: number; count: number }>
}

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)

export default function TopMerchants({ merchants }: Props) {
  if (merchants.length === 0) {
    return <div style={{ color: "#5a7a5a", fontSize: 13 }}>No merchant data yet.</div>
  }

  return (
    <div>
      {merchants.map((m, idx) => (
        <div key={m.merchant} style={{
          display: "grid",
          gridTemplateColumns: "20px 1fr auto",
          gap: 10, alignItems: "baseline",
          padding: "10px 0",
          borderBottom: idx < merchants.length - 1 ? "1px solid #1e2b1e" : "none",
        }}>
          <span style={{
            fontFamily: "IBM Plex Mono, monospace",
            fontSize: 10, color: "#5a7a5a",
          }}>{String(idx + 1).padStart(2, "0")}</span>
          <div style={{ minWidth: 0 }}>
            <div style={{
              fontSize: 13, color: "#d4e8d4",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>{m.merchant}</div>
            <div style={{
              fontFamily: "IBM Plex Mono, monospace",
              fontSize: 10, color: "#5a7a5a", marginTop: 2,
            }}>
              {m.count} {m.count === 1 ? "transaction" : "transactions"}
            </div>
          </div>
          <div style={{
            fontFamily: "Fraunces, Georgia, serif",
            fontSize: 15, color: "#e8f4e8",
          }}>{fmt(m.total)}</div>
        </div>
      ))}
    </div>
  )
}
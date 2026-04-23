import React from "react"

interface Props {
  purchases: Array<{
    id: string; merchant: string; amount: number;
    date: string; category: string; color: string
  }>
}

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)

const fmtDate = (iso: string) => {
  const d = new Date(iso + "T00:00:00")
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

export default function LargestPurchases({ purchases }: Props) {
  if (purchases.length === 0) {
    return <div style={{ color: "#5a7a5a", fontSize: 13 }}>No purchase data yet.</div>
  }

  return (
    <div>
      {purchases.map((p, idx) => (
        <div key={p.id} style={{
          display: "grid",
          gridTemplateColumns: "12px 1fr auto",
          gap: 12, alignItems: "center",
          padding: "12px 0",
          borderBottom: idx < purchases.length - 1 ? "1px solid #1e2b1e" : "none",
        }}>
          <div style={{
            width: 12, height: 12, borderRadius: 3, background: p.color,
          }} title={p.category} />
          <div style={{ minWidth: 0 }}>
            <div style={{
              fontSize: 13, color: "#d4e8d4",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>{p.merchant}</div>
            <div style={{
              fontFamily: "IBM Plex Mono, monospace",
              fontSize: 10, color: "#5a7a5a", marginTop: 2,
            }}>
              {fmtDate(p.date)} · {p.category}
            </div>
          </div>
          <div style={{
            fontFamily: "Fraunces, Georgia, serif",
            fontSize: 15, color: "#e8f4e8",
          }}>{fmt(p.amount)}</div>
        </div>
      ))}
    </div>
  )
}
import { EnrichedTransaction } from "./types"
import TransactionDetail from "./TransactionDetail"

const fmt = (n: number, code = "USD") =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: code,
  }).format(n)

interface Props {
  transaction: EnrichedTransaction
  isExpanded: boolean
  onToggle: () => void
  onUpdated: (updated: EnrichedTransaction) => void
}

export default function TransactionCard({
  transaction: tx,
  isExpanded,
  onToggle,
  onUpdated,
}: Props) {
  return (
    <div
      style={{
        background: "#111",
        border: "1px solid #1e1e1e",
        borderRadius: 10,
        marginBottom: 8,
        overflow: "hidden",
      }}
    >
      <div
        onClick={onToggle}
        style={{
          padding: "14px 16px",
          cursor: "pointer",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
          }}
        >
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "#d0cdc8",
              flex: 1,
              marginRight: 12,
              lineHeight: 1.3,
            }}
          >
            {tx.displayName}
          </div>

          <div
            style={{
              fontFamily: "IBM Plex Mono, monospace",
              fontSize: 15,
              fontWeight: 500,
              color: tx.amount > 0 ? "#ff6b6b" : "#00e5a0",
              whiteSpace: "nowrap",
            }}
          >
            {tx.amount > 0 ? "-" : "+"}
            {fmt(Math.abs(tx.amount))}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              fontFamily: "IBM Plex Mono, monospace",
              fontSize: 11,
              color: "#555",
            }}
          >
            {tx.date ? String(tx.date).slice(0, 10) : "—"}
          </span>

          {tx.category && (
            <span
              style={{
                display: "inline-block",
                background: "#1a1a2e",
                color: tx.color || "#7b9fff",
                fontSize: 10,
                fontFamily: "IBM Plex Mono, monospace",
                padding: "2px 7px",
                borderRadius: 3,
              }}
            >
              {tx.category}
            </span>
          )}

          {tx.tags?.map((tag) => (
            <span
              key={tag}
              style={{
                display: "inline-block",
                background: "rgba(74,158,255,0.1)",
                border: "1px solid rgba(74,158,255,0.2)",
                color: "#4a9eff",
                fontFamily: "IBM Plex Mono, monospace",
                fontSize: 10,
                padding: "1px 6px",
                borderRadius: 3,
              }}
            >
              {tag}
            </span>
          ))}
        </div>
      </div>

      {isExpanded && (
        <TransactionDetail
          transaction={tx}
          onClose={onToggle}
          onUpdate={onUpdated}
        />
      )}
    </div>
  )
}

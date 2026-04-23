import React, { useCallback, useEffect, useRef, useState } from "react"
import { useAuth } from "@clerk/clerk-react"
import { API_URL } from "./config"
import type { EnrichedTransaction, SearchResult, CategoryOption } from "./types"
import MerchantAvatar from "./MerchantAvatar"

interface Props { onRowClick: (tx: EnrichedTransaction) => void }

interface Filters {
  q: string
  category: string       // "All" means no filter
  dateFrom: string
  dateTo: string
}

const EMPTY: Filters = { q: "", category: "All", dateFrom: "", dateTo: "" }

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n)
const fmtDate = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })

export default function TransactionList({ onRowClick }: Props) {
  const { getToken, isSignedIn } = useAuth()
  const [filters, setFilters] = useState<Filters>(EMPTY)
  const [searchInput, setSearchInput] = useState("")
  const [showDrawer, setShowDrawer] = useState(false)
  const [categories, setCategories] = useState<CategoryOption[]>([])
  const [rows, setRows] = useState<EnrichedTransaction[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  // Debounce search input → filters.q
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters(f => f.q === searchInput ? f : { ...f, q: searchInput })
    }, 300)
    return () => clearTimeout(t)
  }, [searchInput])

  // Fetch categories once for the dropdown
  useEffect(() => {
    if (!isSignedIn) return
    ;(async () => {
      const token = await getToken()
      const res = await fetch(`${API_URL}/categories/list`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) setCategories(await res.json())
    })()
  }, [isSignedIn, getToken])

  // Main search — re-runs when any filter changes
  const runSearch = useCallback(async (cursor: string | null) => {
    const token = await getToken()
    const qs = new URLSearchParams()
    if (filters.q) qs.set("q", filters.q)
    if (filters.category !== "All") qs.set("category", filters.category)
    if (filters.dateFrom) qs.set("dateFrom", filters.dateFrom)
    if (filters.dateTo)   qs.set("dateTo", filters.dateTo)
    if (cursor) qs.set("cursor", cursor)
    qs.set("limit", "50")
    const res = await fetch(`${API_URL}/transactions/search?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    return res.ok ? (await res.json() as SearchResult) : null
  }, [getToken, filters])

  useEffect(() => {
    if (!isSignedIn) return
    setLoading(true)
    runSearch(null).then(result => {
      if (result) {
        setRows(result.transactions)
        setNextCursor(result.nextCursor)
      }
      setLoading(false)
    })
  }, [isSignedIn, runSearch])

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    const result = await runSearch(nextCursor)
    if (result) {
      setRows(prev => [...prev, ...result.transactions])
      setNextCursor(result.nextCursor)
    }
    setLoadingMore(false)
  }

  // Active filter chips (everything except q, which has its own input)
  const chips: Array<{ label: string; clear: () => void }> = []
  if (filters.category !== "All") {
    chips.push({ label: filters.category, clear: () => setFilters(f => ({ ...f, category: "All" })) })
  }
  if (filters.dateFrom || filters.dateTo) {
    const lbl = filters.dateFrom && filters.dateTo
      ? `${filters.dateFrom} → ${filters.dateTo}`
      : filters.dateFrom ? `from ${filters.dateFrom}`
      : `until ${filters.dateTo}`
    chips.push({ label: lbl, clear: () => setFilters(f => ({ ...f, dateFrom: "", dateTo: "" })) })
  }

  return (
    <div>
      {/* Filter bar */}
      <div style={{
        background: "#111710", border: "1px solid #253325",
        borderRadius: 8, padding: "10px 14px",
        display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
        marginBottom: 10,
      }}>
        <span style={{
          fontFamily: "IBM Plex Mono, monospace", fontSize: 11, color: "#5a7a5a",
          letterSpacing: ".06em",
        }}>SEARCH</span>
        <input
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          placeholder="Whole Foods, Amazon, gas..."
          style={{
            flex: 1, minWidth: 160,
            background: "transparent", border: "none", outline: "none",
            color: "#d4e8d4", fontFamily: "DM Sans, system-ui, sans-serif", fontSize: 13,
            padding: "4px 0",
          }}
        />
        {chips.map((c, i) => (
          <span key={i} onClick={c.clear} style={{
            fontFamily: "IBM Plex Mono, monospace", fontSize: 10,
            background: "rgba(255,122,107,0.08)", color: "#ff7a6b",
            border: "1px solid rgba(255,122,107,.3)",
            padding: "3px 10px", borderRadius: 16,
            display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer",
          }}>
            {c.label} <span style={{ color: "#5a7a5a", fontSize: 12 }}>×</span>
          </span>
        ))}
        <button onClick={() => setShowDrawer(s => !s)} style={{
          background: showDrawer ? "#ff7a6b" : "transparent",
          color: showDrawer ? "#000" : "#5a7a5a",
          border: "1px solid " + (showDrawer ? "#ff7a6b" : "#253325"),
          padding: "5px 12px", borderRadius: 6, cursor: "pointer",
          fontFamily: "IBM Plex Mono, monospace", fontSize: 10.5,
          letterSpacing: ".04em",
        }}>{showDrawer ? "close" : "filters"}</button>
      </div>

      {/* Filter drawer */}
      {showDrawer && (
        <div style={{
          background: "#0d1510", border: "1px solid #1e2b1e", borderRadius: 8,
          padding: "14px 16px", marginBottom: 10,
          display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10,
        }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 10, color: "#5a7a5a" }}>CATEGORY</span>
            <select
              value={filters.category}
              onChange={e => setFilters(f => ({ ...f, category: e.target.value }))}
              style={{
                background: "#161e14", border: "1px solid #253325", color: "#d4e8d4",
                padding: "6px 8px", borderRadius: 4, fontFamily: "inherit", fontSize: 12.5,
              }}>
              <option value="All">All categories</option>
              {categories.map(c => <option key={c.category} value={c.category}>{c.category}</option>)}
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 10, color: "#5a7a5a" }}>FROM</span>
            <input
              type="date" value={filters.dateFrom}
              onChange={e => setFilters(f => ({ ...f, dateFrom: e.target.value }))}
              style={{
                background: "#161e14", border: "1px solid #253325", color: "#d4e8d4",
                padding: "6px 8px", borderRadius: 4, fontFamily: "inherit", fontSize: 12.5,
              }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 10, color: "#5a7a5a" }}>TO</span>
            <input
              type="date" value={filters.dateTo}
              onChange={e => setFilters(f => ({ ...f, dateTo: e.target.value }))}
              style={{
                background: "#161e14", border: "1px solid #253325", color: "#d4e8d4",
                padding: "6px 8px", borderRadius: 4, fontFamily: "inherit", fontSize: 12.5,
              }}
            />
          </label>
        </div>
      )}

      {/* Results */}
      {loading ? (
        <div style={{ color: "#5a7a5a", fontSize: 13, padding: 20 }}>Loading transactions…</div>
      ) : rows.length === 0 ? (
        <div style={{ color: "#5a7a5a", fontSize: 13, padding: 20 }}>No transactions match these filters.</div>
      ) : (
        <>
          {rows.map(tx => (
            <div key={tx.id} onClick={() => onRowClick(tx)} style={{
              display: "grid",
              gridTemplateColumns: "36px 1fr auto",
              gap: 12, padding: "12px 0",
              borderBottom: "1px solid #1e2b1e",
              alignItems: "center", cursor: "pointer",
            }}>
              <MerchantAvatar name={tx.displayName} logoUrl={tx.logoUrl} />
              <div style={{ minWidth: 0 }}>
                <div style={{
                  fontSize: 13.5, color: "#d4e8d4",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>{tx.displayName}</div>
                <div style={{
                  display: "flex", gap: 8, alignItems: "center",
                  fontFamily: "IBM Plex Mono, monospace", fontSize: 10,
                  color: "#5a7a5a", marginTop: 3,
                }}>
                  <span>{fmtDate(tx.date)}</span>
                  <span style={{
                    padding: "1px 6px", borderRadius: 3,
                    background: "#0d1510", border: "1px solid #253325",
                    textTransform: "uppercase", letterSpacing: ".06em",
                  }}>{tx.category}</span>
                  {tx.tags.slice(0, 2).map(t => (
                    <span key={t} style={{
                      padding: "1px 6px", borderRadius: 3,
                      background: "rgba(74,158,255,0.08)", color: "#4a9eff",
                      border: "1px solid rgba(74,158,255,.3)",
                      textTransform: "uppercase", letterSpacing: ".06em",
                    }}>{t}</span>
                  ))}
                </div>
              </div>
              <div style={{
                fontFamily: "Fraunces, Georgia, serif", fontSize: 15, color: "#e8f4e8",
              }}>{tx.amount < 0 ? `+${fmt(Math.abs(tx.amount))}` : fmt(tx.amount)}</div>
            </div>
          ))}

          <div style={{ textAlign: "center", padding: "16px 0" }}>
            {nextCursor ? (
              <button onClick={loadMore} disabled={loadingMore} style={{
                background: "transparent", color: "#5a7a5a",
                border: "1px solid #253325", padding: "6px 18px", borderRadius: 20,
                cursor: loadingMore ? "default" : "pointer",
                fontFamily: "IBM Plex Mono, monospace", fontSize: 10.5,
                letterSpacing: ".04em", opacity: loadingMore ? 0.5 : 1,
              }}>{loadingMore ? "Loading…" : "Load 50 more"}</button>
            ) : rows.length > 50 ? (
              <span style={{
                fontFamily: "IBM Plex Mono, monospace", fontSize: 10, color: "#5a7a5a",
                letterSpacing: ".04em",
              }}>End of results</span>
            ) : null}
          </div>
        </>
      )}
    </div>
  )
}
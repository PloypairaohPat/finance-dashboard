import React, { useCallback, useEffect, useMemo, useState } from "react"
import { useAuth } from "@clerk/clerk-react"
import { useSearchParams } from "react-router-dom"
import { API_URL } from "./config"
import { useApiFetch } from "./lib/useApiFetch"
import { useDemo } from "./lib/DemoContext"
import type { EnrichedTransaction, SearchResult, CategoryOption } from "./types"
import MerchantAvatar from "./MerchantAvatar"

interface Props { onRowClick: (tx: EnrichedTransaction) => void }

interface Filters {
  q: string
  category: string       // "All" means no filter
  dateFrom: string
  dateTo: string
}

// A filter at its default is omitted from the URL entirely, so a clean view has
// a clean address bar and `?demo=1` isn't buried in empty params.
const DEFAULTS: Filters = { q: "", category: "All", dateFrom: "", dateTo: "" }

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n)
const fmtDate = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })

export default function TransactionList({ onRowClick }: Props) {
  const { isSignedIn } = useAuth()
  const apiFetch = useApiFetch()
  const { demoMode } = useDemo()
  const [searchParams, setSearchParams] = useSearchParams()

  // ── Filters live in the URL, not in state ───────────────────────
  // The URL is the single source of truth, so a filtered view is linkable and
  // Back/Forward moves between filter states.
  //
  // Read as individual strings and re-assembled with useMemo — deriving the
  // object inline would produce a new identity every render, which would
  // invalidate runSearch's useCallback and re-fire the fetch effect forever.
  const q = searchParams.get("q") ?? DEFAULTS.q
  const category = searchParams.get("category") ?? DEFAULTS.category
  const dateFrom = searchParams.get("dateFrom") ?? DEFAULTS.dateFrom
  const dateTo = searchParams.get("dateTo") ?? DEFAULTS.dateTo
  const filters: Filters = useMemo(
    () => ({ q, category, dateFrom, dateTo }),
    [q, category, dateFrom, dateTo],
  )

  // Writes only the keys it is given, onto whatever the URL currently holds —
  // so `?demo=1` (owned by DemoUrlSync) and the other filters survive untouched.
  // The functional form reads the latest params rather than a captured copy,
  // which is what makes this safe to interleave with DemoUrlSync's writes.
  // `replace` so filter changes don't stack up history entries.
  const setFilter = useCallback((patch: Partial<Filters>) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      for (const [key, value] of Object.entries(patch) as [keyof Filters, string][]) {
        if (value === DEFAULTS[key]) next.delete(key)
        else next.set(key, value)
      }
      return next
    }, { replace: true })
  }, [setSearchParams])

  const [searchInput, setSearchInput] = useState(q)
  const [showDrawer, setShowDrawer] = useState(false)
  const [categories, setCategories] = useState<CategoryOption[]>([])
  const [rows, setRows] = useState<EnrichedTransaction[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  // Debounce typing → the URL. Only the settled value is written, so a search
  // doesn't put one history/URL update per keystroke into the address bar.
  useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput !== q) setFilter({ q: searchInput })
    }, 300)
    return () => clearTimeout(t)
  }, [searchInput, q, setFilter])

  // Adopt q when it changes from outside this input — a deep link, Back/Forward,
  // or a cleared filter. Depends on the string, not the params object, so
  // unrelated writes (DemoUrlSync toggling `demo`) don't disturb the input.
  // Our own debounced write lands here too, but searchInput already equals it
  // by then, so it no-ops rather than fighting the user mid-type.
  useEffect(() => {
    setSearchInput((prev) => (prev === q ? prev : q))
  }, [q])

  // Fetch categories once for the dropdown
  useEffect(() => {
    if (!demoMode && !isSignedIn) return
    ;(async () => {
      const res = await apiFetch(`${API_URL}/budgets/categories`)
      if (res.ok) setCategories(await res.json())
    })()
  }, [demoMode, isSignedIn, apiFetch])

  // Main search — re-runs when any filter changes
  const runSearch = useCallback(async (cursor: string | null) => {
    const qs = new URLSearchParams()
    if (filters.q) qs.set("q", filters.q)
    if (filters.category !== "All") qs.set("category", filters.category)
    if (filters.dateFrom) qs.set("dateFrom", filters.dateFrom)
    if (filters.dateTo)   qs.set("dateTo", filters.dateTo)
    if (cursor) qs.set("cursor", cursor)
    qs.set("limit", "50")
    const res = await apiFetch(`${API_URL}/transactions/search?${qs}`)
    return res.ok ? (await res.json() as SearchResult) : null
  }, [apiFetch, filters])

  useEffect(() => {
    if (!demoMode && !isSignedIn) return
    setLoading(true)
    runSearch(null).then(result => {
      if (result) {
        setRows(result.transactions)
        setNextCursor(result.nextCursor)
      }
      setLoading(false)
    })
  }, [demoMode, isSignedIn, runSearch])

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
    chips.push({ label: filters.category, clear: () => setFilter({ category: "All" }) })
  }
  if (filters.dateFrom || filters.dateTo) {
    const lbl = filters.dateFrom && filters.dateTo
      ? `${filters.dateFrom} → ${filters.dateTo}`
      : filters.dateFrom ? `from ${filters.dateFrom}`
      : `until ${filters.dateTo}`
    chips.push({ label: lbl, clear: () => setFilter({ dateFrom: "", dateTo: "" }) })
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
              onChange={e => setFilter({ category: e.target.value })}
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
              onChange={e => setFilter({ dateFrom: e.target.value })}
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
              onChange={e => setFilter({ dateTo: e.target.value })}
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
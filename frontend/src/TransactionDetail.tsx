import React, { useEffect, useState } from "react"
import { API_URL } from "./config"
import { useApiFetch } from "./lib/useApiFetch"
import type { EnrichedTransaction, CategoryOption } from "./types"
import MerchantAvatar from "./MerchantAvatar"

interface Props {
  transaction: EnrichedTransaction
  onClose: () => void
  onUpdate: (updated: EnrichedTransaction) => void
}

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n)
const fmtDate = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })

export default function TransactionDetail({ transaction, onClose, onUpdate }: Props) {
  const apiFetch = useApiFetch()
  const [tags, setTags] = useState<string[]>(transaction.tags)
  const [notes, setNotes] = useState(transaction.notes ?? "")
  const [category, setCategory] = useState(transaction.category)
  const [tagInput, setTagInput] = useState("")
  const [suggestedTags, setSuggestedTags] = useState<string[]>([])
  const [categoryOptions, setCategoryOptions] = useState<CategoryOption[]>([])

  // Fetch suggested tags + category list once on open
  useEffect(() => {
    ;(async () => {
      const [tagRes, catRes] = await Promise.all([
        apiFetch(`${API_URL}/transactions/tags`),
        apiFetch(`${API_URL}/categories/list`),
      ])
      if (tagRes.ok) setSuggestedTags(await tagRes.json())
      if (catRes.ok) setCategoryOptions(await catRes.json())
    })()
  }, [apiFetch])

  // Auto-save on change (debounced 500ms)
  useEffect(() => {
    const t = setTimeout(async () => {
      const body: any = { tags, notes }
      if (category !== transaction.category) body.category = category
      const res = await apiFetch(`${API_URL}/transactions/${transaction.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        onUpdate({ ...transaction, tags, notes, category })
      }
    }, 500)
    return () => clearTimeout(t)
  }, [tags, notes, category]) // eslint-disable-line

  const addTag = (t: string) => {
    const clean = t.trim().toLowerCase()
    if (!clean || tags.includes(clean)) return
    setTags([...tags, clean])
    setTagInput("")
  }

  const removeTag = (t: string) => setTags(tags.filter(x => x !== t))

  // Suggestions: user's existing tags, filtered by current input, not already applied
  const suggestions = suggestedTags
    .filter(t => !tags.includes(t))
    .filter(t => !tagInput || t.toLowerCase().includes(tagInput.toLowerCase()))
    .slice(0, 5)

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0,
        background: "rgba(10,15,12,0.7)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 100, padding: 20,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: "#111710", border: "1px solid #253325", borderRadius: 12,
          padding: 28, maxWidth: 480, width: "100%", maxHeight: "90vh", overflowY: "auto",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 20 }}>
          <MerchantAvatar name={transaction.displayName} logoUrl={transaction.logoUrl} size={48} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontFamily: "Fraunces, Georgia, serif", fontWeight: 300, fontSize: 20,
              color: "#e8f4e8", lineHeight: 1.2,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>
              {transaction.displayName}
            </div>
            <div style={{
              fontFamily: "IBM Plex Mono, monospace", fontSize: 10,
              color: "#5a7a5a", marginTop: 4, letterSpacing: ".04em",
            }}>
              {fmtDate(transaction.date)} · {transaction.account}
            </div>
          </div>
          <div style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 22, color: "#e8f4e8" }}>
            {fmt(transaction.amount)}
          </div>
        </div>

        {/* Category */}
        <div style={{ marginBottom: 20 }}>
          <div style={{
            fontFamily: "IBM Plex Mono, monospace", fontSize: 10,
            color: "#5a7a5a", textTransform: "uppercase", letterSpacing: ".08em",
            marginBottom: 6,
          }}>
            Category
          </div>
          <select
            value={category}
            onChange={e => setCategory(e.target.value)}
            style={{
              width: "100%",
              background: "#0d1510", border: "1px solid #253325", color: "#d4e8d4",
              padding: "8px 10px", borderRadius: 6,
              fontFamily: "inherit", fontSize: 13, outline: "none",
            }}
          >
            {categoryOptions.map(c => (
              <option key={c.category} value={c.category}>{c.category}</option>
            ))}
          </select>
        </div>

        {/* Tags */}
        <div style={{ marginBottom: 20 }}>
          <div style={{
            fontFamily: "IBM Plex Mono, monospace", fontSize: 10,
            color: "#5a7a5a", textTransform: "uppercase", letterSpacing: ".08em",
            marginBottom: 6,
          }}>
            Tags
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
            {tags.map(t => (
              <span
                key={t}
                onClick={() => removeTag(t)}
                style={{
                  fontFamily: "IBM Plex Mono, monospace", fontSize: 10,
                  background: "rgba(74,158,255,0.08)", color: "#4a9eff",
                  border: "1px solid rgba(74,158,255,.3)",
                  padding: "3px 10px", borderRadius: 14, cursor: "pointer",
                }}
              >
                {t} <span style={{ color: "#5a7a5a" }}>×</span>
              </span>
            ))}
          </div>
          <input
            value={tagInput}
            onChange={e => setTagInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addTag(tagInput) } }}
            placeholder="Add a tag…"
            style={{
              width: "100%",
              background: "#0d1510", border: "1px solid #253325", color: "#d4e8d4",
              padding: "6px 10px", borderRadius: 6, fontFamily: "inherit", fontSize: 12.5,
              outline: "none",
            }}
          />
          {suggestions.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              {suggestions.map(t => (
                <span
                  key={t}
                  onClick={() => addTag(t)}
                  style={{
                    fontFamily: "IBM Plex Mono, monospace", fontSize: 10,
                    background: "transparent", color: "#5a7a5a",
                    border: "1px dashed #253325",
                    padding: "3px 10px", borderRadius: 14, cursor: "pointer",
                  }}
                >
                  + {t}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Notes */}
        <div style={{ marginBottom: 8 }}>
          <div style={{
            fontFamily: "IBM Plex Mono, monospace", fontSize: 10,
            color: "#5a7a5a", textTransform: "uppercase", letterSpacing: ".08em",
            marginBottom: 6,
          }}>
            Notes
          </div>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Add a note…"
            rows={3}
            style={{
              width: "100%", resize: "vertical",
              background: "#0d1510", border: "1px solid #253325", color: "#d4e8d4",
              padding: "8px 10px", borderRadius: 6, fontFamily: "inherit", fontSize: 12.5,
              lineHeight: 1.5, outline: "none",
            }}
          />
        </div>

        <div style={{
          fontFamily: "IBM Plex Mono, monospace", fontSize: 9,
          color: "#5a7a5a", letterSpacing: ".08em", textTransform: "uppercase",
          textAlign: "center", marginTop: 16,
        }}>
          Changes save automatically.
        </div>
      </div>
    </div>
  )
}

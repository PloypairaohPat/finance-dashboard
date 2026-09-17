import React, { useEffect, useState } from "react"
import { API_URL } from "./config"
import { useApiFetch } from "./lib/useApiFetch"
import { readWriteResult } from "./lib/writeResult"
import type { EnrichedTransaction, CategoryOption } from "./types"
import MerchantAvatar from "./MerchantAvatar"
import { treatmentFor } from "./rowTreatment"

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
  const look = treatmentFor(transaction.amount, transaction.meaning, fmt)
  const [tags, setTags] = useState<string[]>(transaction.tags)
  const [notes, setNotes] = useState(transaction.notes ?? "")
  const [category, setCategory] = useState(transaction.category)
  const [tagInput, setTagInput] = useState("")
  const [suggestedTags, setSuggestedTags] = useState<string[]>([])
  const [categoryOptions, setCategoryOptions] = useState<CategoryOption[]>([])
  // Why the latest auto-save didn't happen. Null while saves are succeeding.
  const [saveError, setSaveError] = useState<string | null>(null)

  // Fetch suggested tags + category list once on open
  useEffect(() => {
    ;(async () => {
      const [tagRes, catRes] = await Promise.all([
        apiFetch(`${API_URL}/transactions/tags`),
        apiFetch(`${API_URL}/budgets/categories`),
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
      try {
        const res = await apiFetch(`${API_URL}/transactions/${transaction.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        // Not res.ok alone: a blocked demo write is HTTP 200 { demo: true, ok: false },
        // which used to update the list as if the edit had saved.
        const result = await readWriteResult(res)
        if (!result.ok) {
          // The edits stay in the form so nothing typed is lost, but the list
          // isn't updated and the footer says they weren't saved.
          setSaveError(result.message)
          return
        }
        setSaveError(null)
        onUpdate({ ...transaction, tags, notes, category })
      } catch (e: any) {
        setSaveError(e.message)
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
        {/* Wraps on narrow screens: the amount drops below rather than squeezing
            the merchant name down to a few characters. */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center", marginBottom: 20 }}>
          <MerchantAvatar name={transaction.displayName} logoUrl={transaction.logoUrl} size={48} />
          <div style={{ flex: "1 1 180px", minWidth: 0 }}>
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
            {/* What this transaction IS — always shown, and allowed to wrap
                onto its own line rather than be cut off. */}
            <div style={{ marginTop: 6 }}>
              <span data-testid="meaning-chip" style={{
                display: "inline-block",
                padding: "2px 8px", borderRadius: 3,
                fontFamily: "IBM Plex Mono, monospace", fontSize: 10,
                textTransform: "uppercase", letterSpacing: ".06em",
                whiteSpace: "nowrap",
                ...(look.chip
                  ? { color: look.chip.color, background: look.chip.background, border: `1px solid ${look.chip.border}` }
                  : { color: "#8ab88a", background: "#0d1510", border: "1px solid #253325" }),
              }}>{look.chip?.label ?? transaction.meaning.label}</span>
            </div>
          </div>
          {/* Styled from the verdict, not the sign. Previously this printed the raw
              Plaid amount, so income read "-$2,450.00" here and "+" in the list. */}
          <div style={{
            fontFamily: "Fraunces, Georgia, serif", fontSize: 22,
            color: look.amountColor, whiteSpace: "nowrap",
          }}>
            {look.amountText}
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

        {saveError ? (
          <div role="alert" style={{
            fontFamily: "IBM Plex Mono, monospace", fontSize: 10.5,
            color: "#e85555", textAlign: "center", marginTop: 16,
          }}>
            ⚠ Changes not saved: {saveError}
          </div>
        ) : (
          <div style={{
            fontFamily: "IBM Plex Mono, monospace", fontSize: 9,
            color: "#5a7a5a", letterSpacing: ".08em", textTransform: "uppercase",
            textAlign: "center", marginTop: 16,
          }}>
            Changes save automatically.
          </div>
        )}
      </div>
    </div>
  )
}

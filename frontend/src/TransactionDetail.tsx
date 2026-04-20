import { useState, useRef } from "react"
import { useAuth } from "@clerk/clerk-react"
import { Transaction } from "./types"
import { API_URL } from "./config"

interface Props {
  transaction: Transaction
  onUpdated: (updated: Transaction) => void
}

export default function TransactionDetail({ transaction, onUpdated }: Props) {
  const [tags, setTags] = useState<string[]>(transaction.tags || [])
  const [notes, setNotes] = useState(transaction.notes || "")
  const [tagInput, setTagInput] = useState("")
  const [saving, setSaving] = useState(false)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { getToken } = useAuth()

  async function saveToPatch(newTags: string[], newNotes: string) {
    setSaving(true)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/transactions/${transaction.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ tags: newTags, notes: newNotes }),
      })
      const data = await res.json()
      if (data.transaction) onUpdated(data.transaction)
    } catch (e: any) {
      console.error("Patch failed:", e.message)
    } finally {
      setSaving(false)
    }
  }

  function addTag() {
    const tag = tagInput.trim().toLowerCase()
    if (!tag || tags.includes(tag)) return
    const next = [...tags, tag]
    setTags(next)
    setTagInput("")
    saveToPatch(next, notes)
  }

  function removeTag(tag: string) {
    const next = tags.filter(t => t !== tag)
    setTags(next)
    saveToPatch(next, notes)
  }

  function handleNotesChange(value: string) {
    setNotes(value)
    if (debounce.current) clearTimeout(debounce.current)
        debounce.current = setTimeout(() => saveToPatch(tags, value), 600)
  }

  return (
    <div
      style={{
        background: "#0d0d0d",
        borderTop: "1px solid #1a2e1a",
        padding: "16px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div>
        <div
          style={{
            fontFamily: "IBM Plex Mono, monospace",
            fontSize: 10,
            color: "#5a7a5a",
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            marginBottom: 8,
          }}
        >
          Tags
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {tags.map(tag => (
            <span
              key={tag}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                background: "rgba(74,158,255,0.1)",
                border: "1px solid rgba(74,158,255,0.2)",
                color: "#4a9eff",
                fontFamily: "IBM Plex Mono, monospace",
                fontSize: 11,
                padding: "3px 8px",
                borderRadius: 4,
              }}
            >
              {tag}
              <button
                onClick={() => removeTag(tag)}
                style={{
                  background: "none",
                  border: "none",
                  color: "#4a9eff",
                  cursor: "pointer",
                  fontSize: 12,
                  padding: 0,
                  lineHeight: 1,
                  opacity: 0.6,
                }}
              >
                ×
              </button>
            </span>
          ))}
          <input
            value={tagInput}
            onChange={e => setTagInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") addTag()
            }}
            placeholder="add tag…"
            style={{
              background: "transparent",
              border: "1px solid #253325",
              borderRadius: 4,
              padding: "3px 8px",
              color: "#d4e8d4",
              fontFamily: "IBM Plex Mono, monospace",
              fontSize: 11,
              width: 100,
              outline: "none",
            }}
          />
        </div>
      </div>

      <div>
        <div
          style={{
            fontFamily: "IBM Plex Mono, monospace",
            fontSize: 10,
            color: "#5a7a5a",
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            marginBottom: 8,
          }}
        >
          Notes {saving && <span style={{ color: "#f0a030", marginLeft: 8, fontSize: 9 }}>saving…</span>}
        </div>
        <textarea
          value={notes}
          onChange={e => handleNotesChange(e.target.value)}
          placeholder="Add a note about this transaction…"
          rows={2}
          style={{
            width: "100%",
            background: "#111710",
            border: "1px solid #253325",
            borderRadius: 6,
            padding: "8px 12px",
            color: "#d4e8d4",
            fontFamily: "IBM Plex Mono, monospace",
            fontSize: 12,
            lineHeight: 1.5,
            resize: "vertical",
            outline: "none",
          }}
        />
      </div>
    </div>
  )
}

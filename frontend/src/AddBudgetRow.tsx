import { useState } from "react"
import { useAuth } from "@clerk/clerk-react"
import { API_URL } from "./config"

const ALL_CATEGORIES = [
  "Food & Dining",
  "Shopping",
  "Bills & Utilities",
  "Transportation",
  "Entertainment",
  "Health & Fitness",
  "Travel",
  "Personal Care",
  "Education",
  "Other",
]

interface Props {
  existingCategories: string[]
  onAdded: () => void
}

export default function AddBudgetRow({ existingCategories, onAdded }: Props) {
  const [open, setOpen] = useState(false)
  const [category, setCategory] = useState("")
  const [limit, setLimit] = useState("")
  const [saving, setSaving] = useState(false)
  const { getToken } = useAuth()

  const available = ALL_CATEGORIES.filter(c => !existingCategories.includes(c))

  async function submit() {
    const val = parseFloat(limit)
    if (!category || isNaN(val) || val <= 0) return

    setSaving(true)
    try {
      const token = await getToken()
      const now = new Date()
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
      await fetch(`${API_URL}/budgets`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ category, monthlyLimit: val, month }),
      })
      setCategory("")
      setLimit("")
      setOpen(false)
      onAdded()
    } finally {
      setSaving(false)
    }
  }

  if (available.length === 0) return null

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          width: "100%",
          background: "transparent",
          border: "1px dashed #253325",
          color: "#5a7a5a",
          padding: "10px 14px",
          borderRadius: 8,
          cursor: "pointer",
          fontFamily: "IBM Plex Mono, monospace",
          fontSize: 11,
          letterSpacing: ".04em",
          marginTop: 4,
        }}
      >
        + Add a budget
      </button>
    )
  }

  return (
    <div style={{
      background: "#0d1510",
      border: "1px solid #253325",
      borderRadius: 8,
      padding: 14,
      marginTop: 4,
      display: "flex",
      flexDirection: "column",
      gap: 8,
    }}>
      <select
        autoFocus
        value={category}
        onChange={e => setCategory(e.target.value)}
        style={{
          background: "#161e14",
          border: "1px solid #253325",
          color: category ? "#d4e8d4" : "#5a7a5a",
          padding: "7px 10px",
          borderRadius: 6,
          fontFamily: "IBM Plex Mono, monospace",
          fontSize: 12,
          outline: "none",
        }}
      >
        <option value="">Select category…</option>
        {available.map(c => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>

      <input
        type="number"
        placeholder="Monthly limit ($)"
        value={limit}
        onChange={e => setLimit(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter") submit()
          if (e.key === "Escape") setOpen(false)
        }}
        style={{
          background: "#161e14",
          border: "1px solid #253325",
          color: "#d4e8d4",
          padding: "7px 10px",
          borderRadius: 6,
          fontFamily: "IBM Plex Mono, monospace",
          fontSize: 12,
          outline: "none",
        }}
      />

      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={submit}
          disabled={!category || !limit || saving}
          style={{
            background: "#00e87a",
            color: "#000",
            border: "none",
            padding: "7px 16px",
            borderRadius: 6,
            cursor: category && limit ? "pointer" : "default",
            fontFamily: "IBM Plex Mono, monospace",
            fontSize: 11,
            fontWeight: 600,
            opacity: category && limit ? 1 : 0.4,
          }}
        >
          {saving ? "Saving…" : "Add"}
        </button>
        <button
          onClick={() => { setOpen(false); setCategory(""); setLimit("") }}
          style={{
            background: "transparent",
            color: "#5a7a5a",
            border: "1px solid #253325",
            padding: "7px 16px",
            borderRadius: 6,
            cursor: "pointer",
            fontFamily: "IBM Plex Mono, monospace",
            fontSize: 11,
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

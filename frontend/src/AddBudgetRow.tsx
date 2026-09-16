import { useEffect, useState } from "react"
import { API_URL } from "./config"
import { useApiFetch } from "./lib/useApiFetch"
import { readWriteResult } from "./lib/writeResult"

// The category list comes from GET /budgets/categories (M7.3). It used to be
// hardcoded here and had drifted from what the API accepts in both directions:
// it offered Health & Fitness, Personal Care and Education, which upsertBudget
// rejects, and hid Housing, Subscriptions and Debt, which it accepts. Choosing
// a rejected one failed the write — silently, until readWriteResult surfaced it.
// backend/tests/budget-categories.test.ts pins that the endpoint's list is
// exactly the set the API accepts, which is what makes this safe.

interface Props {
  existingCategories: string[]
  onAdded: () => void
}

export default function AddBudgetRow({ existingCategories, onAdded }: Props) {
  const [open, setOpen] = useState(false)
  const [category, setCategory] = useState("")
  const [limit, setLimit] = useState("")
  const [saving, setSaving] = useState(false)
  // Why the last add didn't happen. The write is read through readWriteResult:
  // a blocked demo write is HTTP 200 { demo: true, ok: false }, and a rejected
  // category is a 500 — both used to close the form as if the budget was added.
  // (The category list itself is still hardcoded — M7.3 notes, *Budgets*.)
  const [error, setError] = useState<string | null>(null)
  // null while the list is still loading — an empty array is a real answer.
  const [allCategories, setAllCategories] = useState<string[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const apiFetch = useApiFetch()

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await apiFetch(`${API_URL}/budgets/categories`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as Array<{ category: string }>
        if (!cancelled) setAllCategories(data.map(c => c.category))
      } catch (e: any) {
        // Say so rather than falling back to a guess: a stale local list is
        // exactly what this change removes.
        if (!cancelled) setListError(e.message ?? "could not load categories")
      }
    })()
    return () => { cancelled = true }
  }, [apiFetch])

  const available = (allCategories ?? []).filter(c => !existingCategories.includes(c))
  const loading = allCategories === null && listError === null

  async function submit() {
    const val = parseFloat(limit)
    if (!category || isNaN(val) || val <= 0) return

    setSaving(true)
    setError(null)
    try {
      // Content-Type must be set here — useApiFetch adds auth headers only.
      const res = await apiFetch(`${API_URL}/budgets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, monthlyLimit: val }),
      })
      const result = await readWriteResult(res)
      if (!result.ok) {
        // Keep the form open with what was typed, so nothing is silently lost.
        setError(`Budget not added: ${result.message}`)
        return
      }
      setCategory("")
      setLimit("")
      setOpen(false)
      onAdded()
    } catch (e: any) {
      setError(`Budget not added: ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  // Only hide the control once the real list says every category is budgeted.
  if (allCategories !== null && available.length === 0) return null

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
        disabled={loading || listError !== null}
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
          opacity: loading || listError ? 0.5 : 1,
        }}
      >
        <option value="">
          {loading ? "Loading categories…" : listError ? "Categories unavailable" : "Select category…"}
        </option>
        {available.map(c => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>

      {listError && (
        <div role="alert" style={{
          fontFamily: "IBM Plex Mono, monospace",
          fontSize: 11,
          color: "#e85555",
        }}>
          ⚠ Couldn't load the category list: {listError}
        </div>
      )}

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

      {error && (
        <div role="alert" style={{
          fontFamily: "IBM Plex Mono, monospace",
          fontSize: 11,
          color: "#e85555",
        }}>
          ⚠ {error}
        </div>
      )}

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
          onClick={() => { setOpen(false); setCategory(""); setLimit(""); setError(null) }}
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

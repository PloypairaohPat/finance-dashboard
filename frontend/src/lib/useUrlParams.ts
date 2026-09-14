import { useCallback, useLayoutEffect, useRef } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"

// ─────────────────────────────────────────────────────────────────
//  useUrlParams — the only sanctioned way to read and write URL search params.
//
//  THE RULE: every write is built from the URL as it is at the moment of the
//  write (window.location.search), never from a params object captured at
//  render. React Router's setSearchParams builds from the params of the last
//  render — its functional form receives that same snapshot — so two writes
//  before the next render, or any write from a closure that has outlived a
//  render (after an await, inside a timer, held in a ref), can silently delete
//  params another writer added.
//
//  Writes take a patch of named keys. Keys a caller doesn't name are left
//  exactly as the live URL has them, so a caller cannot remove a param it
//  doesn't know about. A value of null or "" deletes the key.
//
//  Writes from a component that has unmounted are dropped: a save handler that
//  resolves after the user navigated away would otherwise put its params onto
//  whatever page they are on now.
//
//  Not covered: a caller writing a stale VALUE for a key it names itself. That
//  is application logic, not URL plumbing.
//
//  Enforced by no-restricted-imports (frontend/package.json "eslintConfig"),
//  which bans useSearchParams everywhere except this file.
//  Regression test: `npm run repro:url-params` (scripts/url-params-repro/).
// ─────────────────────────────────────────────────────────────────

export type UrlParamPatch = Record<string, string | null>

export function useUrlParams(): [URLSearchParams, (patch: UrlParamPatch) => void] {
  // Reading the render value is correct: it is what this render displays.
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()

  const navigateRef = useRef(navigate)
  navigateRef.current = navigate

  const mountedRef = useRef(false)
  useLayoutEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const writeParams = useCallback((patch: UrlParamPatch) => {
    if (!mountedRef.current) return

    const current = new URLSearchParams(window.location.search)
    const next = new URLSearchParams(current)
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") next.delete(key)
      else next.set(key, value)
    }
    if (next.toString() === current.toString()) return

    const search = next.toString()
    navigateRef.current(
      {
        pathname: window.location.pathname,
        search: search ? `?${search}` : "",
        hash: window.location.hash,
      },
      { replace: true },
    )
  }, [])

  return [searchParams, writeParams]
}

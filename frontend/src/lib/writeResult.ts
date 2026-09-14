// ─────────────────────────────────────────────────────────────────
//  readWriteResult — decide whether a write actually happened.
//
//  `res.ok` is NOT enough. In demo mode the backend's demoReadOnly middleware
//  answers every non-GET request with
//
//      200 { demo: true, ok: false, message: "Demo mode — changes aren't saved…" }
//
//  so a blocked demo write has res.ok === true. Code that only checks res.ok
//  treats it as saved (asserted by backend/tests/isolation.test.ts, "blocked in
//  demo mode"). This helper checks, in order:
//    1. a demo / `ok: false` body  → failed, even on HTTP 200
//    2. a non-2xx status           → failed, with the body's `error` if any
//    3. a 2xx body with `error`    → failed
//  Anything else is success.
//
//  Network failures still throw from fetch itself; callers catch those.
//  See docs/m7.3-data-trust-notes.md, "Blocked demo writes read as success".
// ─────────────────────────────────────────────────────────────────

export type WriteResult =
  | { ok: true; data: unknown }
  | { ok: false; demo: boolean; message: string }

const DEMO_FALLBACK = "Demo mode — changes aren't saved."

export async function readWriteResult(res: Response): Promise<WriteResult> {
  const data: any = await res.json().catch(() => null)
  const body = data && typeof data === "object" ? data : null

  if (body && (body.demo === true || body.ok === false)) {
    const message = typeof body.message === "string" ? body.message
      : typeof body.error === "string" ? body.error
      : body.demo === true ? DEMO_FALLBACK
      : `Request failed (HTTP ${res.status})`
    return { ok: false, demo: body.demo === true, message }
  }
  if (!res.ok) {
    const message = body && typeof body.error === "string" ? body.error : `Request failed (HTTP ${res.status})`
    return { ok: false, demo: false, message }
  }
  if (body && typeof body.error === "string") {
    return { ok: false, demo: false, message: body.error }
  }
  return { ok: true, data }
}

// The Subscriptions & Bills tab, M7.6 PR 5d: Suggested with Confirm and
// Dismiss, "Not recurring" on stream rows, Undo, and "Dismissed (n)" with
// Restore — all rendered only when the response carries them. All names,
// ids and amounts are invented.

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import SubscriptionTracker, { updatedLabel } from "./SubscriptionTracker"
import type { EnrichedStream, SubscriptionAnalysis, SuggestedStream } from "./types"

const mockApiFetch = jest.fn<Promise<Response>, [string, RequestInit?]>()
jest.mock("@clerk/clerk-react", () => ({ useAuth: () => ({ isSignedIn: true }) }))
jest.mock("./lib/useApiFetch", () => ({ useApiFetch: () => mockApiFetch }))
jest.mock("./lib/DemoContext", () => ({ useDemo: () => ({ demoMode: false }) }))
// The app bumps the sync version when POST /sync returns, which is after the sync and the stream refresh.
const mockSync = { version: 0 }
jest.mock("./SyncProvider", () => ({ useSyncVersion: () => mockSync.version }))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const row = (merchant: string, o: Partial<EnrichedStream> = {}): EnrichedStream => ({
  merchant, cleanMerchant: merchant, key: merchant.toLowerCase(), kind: "subscription", category: "Entertainment",
  frequency: "MONTHLY", lastAmount: 10, lastDate: "2026-01-01", lastChargePending: false, monthlyAmount: 10,
  source: "custom", priceChange: null, isDuplicate: false, nextChargeDate: null, daysUntilNextCharge: null,
  txIds: [`${merchant}-tx-1`, `${merchant}-tx-2`, `${merchant}-tx-3`], mark: null, status: "active", ...o,
})
/** A Plaid stream row: its newest charge pending, so the anchor is the one before. */
const stream = (merchant: string, o: Partial<EnrichedStream> = {}) =>
  row(merchant, { source: "plaid", anchorTxId: `${merchant}-tx-2`, lastChargePending: true, ...o })
const suggestion = (merchant: string, o: Partial<SuggestedStream> = {}): SuggestedStream => ({
  ...stream(merchant), confirmsAs: "subscription", isNew: false, reason: "category-unlisted", ...o,
})

/** Today's response: the old detector and marks only. */
const today: SubscriptionAnalysis = {
  subscriptions: [row("Oldflix"), row("Markgym", { mark: { id: "mark-1" } })],
  bills: [row("Powerco", { kind: "bill", monthlyAmount: 80 })],
  upcoming: [], alerts: [],
  totals: { monthlySubscriptions: 20, monthlyBills: 80, monthlyAll: 100 },
}
/** PR 5e's response: streams, suggestions and dismissals. */
const onStreams: SubscriptionAnalysis = {
  subscriptions: [stream("Streamco"), row("Markgym", { mark: { id: "mark-1" } })],
  bills: [stream("Powerco", { kind: "bill", monthlyAmount: 80 })],
  upcoming: [], alerts: [],
  totals: { monthlySubscriptions: 20, monthlyBills: 80, monthlyAll: 100 },
  suggested: [suggestion("Clinic"), suggestion("Newbox", { isNew: true }), suggestion("Tutor", { confirmsAs: "bill" })],
  dismissed: [suggestion("Salon", { mark: { id: "dismissal-1" } })],
}

const reply = (body: object, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response
let server: SubscriptionAnalysis
let writeReply: () => Response
const gets = () => mockApiFetch.mock.calls.filter(([, init]) => !init?.method || init.method === "GET").length
const writes = () => mockApiFetch.mock.calls.filter(([, init]) => init?.method === "POST" || init?.method === "DELETE")
  .map(([url, init]) => ({ method: init!.method, path: url.replace(/^.*\/subscriptions/, "/subscriptions"), body: init!.body ? JSON.parse(init!.body as string) : null }))

let container: HTMLDivElement
let root: Root
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const text = () => container.textContent ?? ""
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
const click = async (label: string) => {
  const b = button(label)
  if (!b) throw new Error(`no button "${label}"`)
  await act(async () => { b.click() })
  await settle()
}

async function mount(analysis: SubscriptionAnalysis) {
  server = analysis
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<SubscriptionTracker />))
  await settle()
}

beforeEach(() => {
  mockSync.version = 0
  mockApiFetch.mockReset()
  writeReply = () => reply({ verdict: { id: "verdict-9", kind: "dismissed", transactionId: "x" } }, 201)
  mockApiFetch.mockImplementation(async (_url, init) =>
    !init?.method || init.method === "GET" ? reply(server) : writeReply())
})
afterEach(() => { act(() => root.unmount()); container.remove() })

describe("SubscriptionTracker", () => {
  it("today's response renders as it always has: no Suggested, no Not recurring, no Dismissed", async () => {
    await mount(today)
    expect(text()).not.toContain("Suggested")
    expect(text()).not.toContain("Not recurring")
    expect(text()).not.toContain("Dismissed")
    expect(text()).toContain("Confirmed by you")
    expect(text()).toContain("$20/mo")
    expect(text()).toContain("$80/mo")
  })

  it("on streams: Suggested lists each one, outside the totals, and flags only the new one", async () => {
    await mount(onStreams)
    expect(text()).toContain("Suggested")
    for (const m of ["Clinic", "Newbox", "Tutor"]) {
      expect(button(`Confirm ${m}`)).not.toBeNull()
      expect(button(`Dismiss ${m}`)).not.toBeNull()
    }
    const newChips = [...container.querySelectorAll("span")].filter((s) => s.textContent === "New")
    expect(newChips).toHaveLength(1)
    expect(newChips[0].closest("div[style]")?.textContent).toContain("Newbox")
    expect(text()).toContain("Confirming adds it to Bills")
    // The totals are the server's: suggestions add nothing.
    expect(text()).toContain("$20/mo")
    expect(text()).toContain("$80/mo")
  })

  it('"Not recurring" is on every stream row, and only stream rows', async () => {
    await mount(onStreams)
    expect(button("Streamco is not recurring")).not.toBeNull()
    expect(button("Powerco is not recurring")).not.toBeNull()
    expect(button("Markgym is not recurring")).toBeNull()
    await click("Powerco is not recurring")
    expect(writes()).toEqual([{ method: "POST", path: "/subscriptions/verdicts", body: { transactionId: "Powerco-tx-2", verdict: "dismissed" } }])
  })

  it("Confirm anchors on the stream's newest posted charge, not a pending one, and reads the tab again", async () => {
    await mount(onStreams)
    const before = gets()
    await click("Confirm Clinic")
    expect(writes()).toEqual([{ method: "POST", path: "/subscriptions/verdicts", body: { transactionId: "Clinic-tx-2", verdict: "confirmed" } }])
    expect(gets()).toBe(before + 1)
  })

  it("Dismiss offers Undo, and Undo deletes that dismissal", async () => {
    await mount(onStreams)
    await click("Dismiss Clinic")
    expect(text()).toContain("Dismissed Clinic.")
    await click("Undo dismissing Clinic")
    expect(writes()).toEqual([
      { method: "POST", path: "/subscriptions/verdicts", body: { transactionId: "Clinic-tx-2", verdict: "dismissed" } },
      { method: "DELETE", path: "/subscriptions/verdicts/verdict-9", body: null },
    ])
    expect(text()).not.toContain("Dismissed Clinic.")
  })

  it('"Dismissed (n)" starts collapsed, and Restore deletes the dismissal', async () => {
    await mount(onStreams)
    const details = container.querySelector("details")!
    expect(details.querySelector("summary")!.textContent).toBe("Dismissed (1)")
    expect(details.open).toBe(false)
    // The dismissal isn't shown as a confirmation.
    expect(details.textContent).not.toContain("Confirmed by you")
    await click("Restore Salon")
    expect(writes()).toEqual([{ method: "DELETE", path: "/subscriptions/verdicts/dismissal-1", body: null }])
  })

  it("demo mode: the demo message, nothing moves, no Undo, and the tab isn't read again", async () => {
    await mount(onStreams)
    writeReply = () => reply({ demo: true, ok: false, message: "Demo mode — changes aren't saved." })
    const before = gets()
    await click("Dismiss Clinic")
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Demo mode")
    expect(text()).not.toContain("Dismissed Clinic.")
    expect(button("Confirm Clinic")).not.toBeNull()
    expect(gets()).toBe(before)
  })

  it("with nothing posted yet, it sends the newest charge and shows the server's pending message", async () => {
    await mount({ ...onStreams, suggested: [suggestion("Fresh", { anchorTxId: null })] })
    writeReply = () => reply({ error: "This charge is still pending. A pending row is replaced by a new one when it posts." }, 409)
    await click("Confirm Fresh")
    expect(writes()).toEqual([{ method: "POST", path: "/subscriptions/verdicts", body: { transactionId: "Fresh-tx-3", verdict: "confirmed" } }])
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("still pending")
  })

  it("Ended says why it isn't counted: Plaid's word for a stream, the missed charges for a marked series", async () => {
    await mount({
      ...onStreams,
      subscriptions: [stream("Gonestream", { status: "ended" }), row("Goneseries", { status: "ended", mark: { id: "mark-2" } })],
    })
    const tip = (merchant: string) =>
      [...container.querySelectorAll("span")].find((s) => s.textContent === "Ended" && s.closest("div[style]")?.textContent?.includes(merchant))?.title
    expect(tip("Gonestream")).toBe("Plaid reports this has stopped: shown, but not counted in the totals")
    expect(tip("Goneseries")).toBe("No charge for two billing periods: not counted in the totals")
  })

  it("reads the tab again when a sync finishes", async () => {
    await mount(onStreams)
    const before = gets()
    mockSync.version = 1
    await act(async () => root.render(<SubscriptionTracker />))
    await settle()
    expect(gets()).toBe(before + 1)
  })

  it("shows how fresh the streams are, by the stalest Item, and nothing when there is nothing to say", async () => {
    const threeHours = new Date(Date.now() - 3 * 3_600_000 - 60_000).toISOString()
    await mount({ ...onStreams, freshness: { oldest: threeHours } })
    expect(text()).toContain("Updated 3h ago")
    act(() => root.unmount()); container.remove()
    await mount({ ...onStreams, freshness: { oldest: null } })
    expect(text()).toContain("Not updated yet")
    act(() => root.unmount()); container.remove()
    await mount({ ...onStreams, freshness: null })
    expect(text()).not.toContain("Updated")
    expect(text()).not.toContain("Not updated")
  })

  it("updatedLabel counts minutes, hours and days", () => {
    const now = Date.parse("2026-10-07T12:00:00Z")
    expect(updatedLabel("2026-10-07T11:59:40Z", now)).toBe("Updated just now")
    expect(updatedLabel("2026-10-07T11:50:00Z", now)).toBe("Updated 10m ago")
    expect(updatedLabel("2026-10-07T07:00:00Z", now)).toBe("Updated 5h ago")
    expect(updatedLabel("2026-10-04T12:00:00Z", now)).toBe("Updated 3d ago")
    expect(updatedLabel(null, now)).toBe("Not updated yet")
  })

  it("a refused write says why", async () => {
    await mount(onStreams)
    writeReply = () => reply({ error: "This charge is still pending." }, 409)
    await click("Confirm Newbox")
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("still pending")
  })
})

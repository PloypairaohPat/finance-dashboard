// "Delete account and all data": a message the server sends with the
// deletion (underway, or the Clerk account still to remove) stays until the
// user dismisses it, and dismissing signs them out.

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import SettingsDialog, { DeleteAccount } from "./SettingsDialog"

const mockSignOut = jest.fn(async (_opts?: unknown) => {})
const mockApiFetch = jest.fn<Promise<Response>, [string, RequestInit?]>()

jest.mock("@clerk/clerk-react", () => ({ useClerk: () => ({ signOut: mockSignOut }) }))
jest.mock("./lib/useApiFetch", () => ({ useApiFetch: () => mockApiFetch }))
const mockSave = jest.fn<Promise<string | null>, [object]>()
const mockSettings = {
  startDay: 1, paymentAppInflowsAreIncome: false, missedPaycheckAlerts: false, regularPaycheckFound: false,
  loaded: true, version: 0, save: (patch: object) => mockSave(patch),
}
const mockDemo = { on: false }
jest.mock("./SettingsProvider", () => ({ useSettings: () => mockSettings }))
jest.mock("./lib/DemoContext", () => ({ useDemo: () => ({ demoMode: mockDemo.on }) }))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const reply = (body: object, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  mockSignOut.mockClear()
  mockApiFetch.mockReset()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<DeleteAccount />))
})
afterEach(() => container.remove())

async function confirmAndDelete() {
  const input = container.querySelector("input")!
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
  await act(async () => {
    setValue.call(input, "delete my data")
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === "Delete account and all data")!
  await act(async () => { button.click() })
}

const UNDERWAY = "Your deletion is underway and will be completed."
const CLERK_PENDING = "Your data is deleted. Removing your sign-in account failed; you are signed out and it will be retried."

describe("DeleteAccount", () => {
  it.each([
    ["deletion underway", { deleted: false, accountDeleted: false, pending: true, message: UNDERWAY }, UNDERWAY],
    ["Clerk account still to remove", { deleted: true, accountDeleted: false, message: CLERK_PENDING }, CLERK_PENDING],
  ])("%s: the message stays until dismissed, then signs out", async (_, body, text) => {
    mockApiFetch.mockResolvedValue(reply(body))
    await confirmAndDelete()
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    expect(container.querySelector('[role="status"]')?.textContent).toContain(text)
    expect(mockSignOut).not.toHaveBeenCalled()

    const ok = [...container.querySelectorAll("button")].find((b) => b.textContent === "OK, sign out")!
    await act(async () => { ok.click() })
    expect(mockSignOut).toHaveBeenCalledTimes(1)
    act(() => root.unmount()) // the redirect unmounts it: no second sign-out
    expect(mockSignOut).toHaveBeenCalledTimes(1)
  })

  it("closing the dialog with the message showing also signs out", async () => {
    mockApiFetch.mockResolvedValue(reply({ deleted: false, accountDeleted: false, pending: true, message: UNDERWAY }))
    await confirmAndDelete()
    expect(mockSignOut).not.toHaveBeenCalled()
    act(() => root.unmount())
    expect(mockSignOut).toHaveBeenCalledTimes(1)
  })

  it("a complete deletion signs out straight away", async () => {
    mockApiFetch.mockResolvedValue(reply({ deleted: true, accountDeleted: true }))
    await confirmAndDelete()
    expect(mockSignOut).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="status"]')).toBeNull()
    act(() => root.unmount())
    expect(mockSignOut).toHaveBeenCalledTimes(1)
  })
})

// ── the missed-paycheck setting (M7.6 PR 6b) ──────────────────────

describe("the missed-paycheck setting", () => {
  let dialog: HTMLDivElement
  let dialogRoot: Root
  const PAYCHECK = "Tell me when a paycheck is late"
  const NONE_FOUND = "We haven’t found a regular paycheck in your linked accounts yet, so this won’t alert you."

  async function open(settings: Partial<typeof mockSettings>, demo = false) {
    Object.assign(mockSettings, { missedPaycheckAlerts: false, regularPaycheckFound: false }, settings)
    mockDemo.on = demo
    mockSave.mockReset()
    dialog = document.createElement("div")
    document.body.appendChild(dialog)
    dialogRoot = createRoot(dialog)
    await act(async () => dialogRoot.render(<SettingsDialog onClose={() => {}} />))
  }
  afterEach(() => { act(() => dialogRoot.unmount()); dialog.remove(); mockDemo.on = false })

  const checkbox = () => [...dialog.querySelectorAll("label")].find((l) => l.textContent?.includes(PAYCHECK))!.querySelector("input")!
  const toggle = async () => { await act(async () => { checkbox().click() }) }
  const saveButton = () => [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Save")!

  it("on, with no regular paycheck found, says plainly that it won't alert", async () => {
    await open({ missedPaycheckAlerts: true, regularPaycheckFound: false })
    expect(dialog.textContent).toContain(NONE_FOUND)
  })

  it("says nothing more when a regular paycheck was found, or when it's off", async () => {
    await open({ missedPaycheckAlerts: true, regularPaycheckFound: true })
    expect(dialog.textContent).not.toContain(NONE_FOUND)
    act(() => dialogRoot.unmount()); dialog.remove()
    await open({ missedPaycheckAlerts: false, regularPaycheckFound: false })
    expect(dialog.textContent).not.toContain(NONE_FOUND)
  })

  it("turning it on shows the message straight away, and Save sends it", async () => {
    await open({ missedPaycheckAlerts: false, regularPaycheckFound: false })
    await toggle()
    expect(checkbox().checked).toBe(true)
    expect(dialog.textContent).toContain(NONE_FOUND)
    expect(mockSave).not.toHaveBeenCalled()
    mockSave.mockResolvedValue(null)
    await act(async () => { saveButton().click() })
    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ missedPaycheckAlerts: true }))
  })

  it("demo mode: shows the stored setting, a change gets the demo message at once, and nothing moves", async () => {
    await open({ missedPaycheckAlerts: true, regularPaycheckFound: true }, true)
    expect(checkbox().checked).toBe(true)
    mockSave.mockResolvedValue("Demo mode — changes aren't saved. Sign up to use it for real.")
    await toggle()
    expect(mockSave).toHaveBeenCalledWith({ missedPaycheckAlerts: false })
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("Demo mode")
    expect(checkbox().checked).toBe(true)
    expect(dialog.textContent).not.toContain("Delete account and all data")
  })
})

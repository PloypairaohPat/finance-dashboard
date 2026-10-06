// "Delete account and all data": a message the server sends with the
// deletion (underway, or the Clerk account still to remove) stays until the
// user dismisses it, and dismissing signs them out.

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { DeleteAccount } from "./SettingsDialog"

const mockSignOut = jest.fn(async (_opts?: unknown) => {})
const mockApiFetch = jest.fn<Promise<Response>, [string, RequestInit?]>()

jest.mock("@clerk/clerk-react", () => ({ useClerk: () => ({ signOut: mockSignOut }) }))
jest.mock("./lib/useApiFetch", () => ({ useApiFetch: () => mockApiFetch }))
jest.mock("./SettingsProvider", () => ({ useSettings: () => ({}) }))

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

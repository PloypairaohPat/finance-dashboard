// The panel's "Mark as …" wording follows where a confirmation lands (M7.6 PR 5e).

import { describe, expect, it } from "@jest/globals"
import { markLabels } from "./markLabels"

describe("markLabels", () => {
  it("a charge that lands in Bills says bill, before and after marking", () => {
    expect(markLabels({ state: "markable", landsIn: "bill" })).toMatchObject({
      button: "Mark as a bill",
      help: expect.stringContaining("under Bills"),
    })
    expect(markLabels({ state: "marked", markId: "m", landsIn: "bill" })).toMatchObject({
      button: "Marked as a bill · Unmark",
      help: expect.stringContaining("Tracked under Bills"),
    })
    expect(markLabels({ state: "detected", landsIn: "bill" }).detected).toContain("under Bills")
  })

  it("a subscription says subscription", () => {
    expect(markLabels({ state: "markable", landsIn: "subscription" }).button).toBe("Mark as a subscription")
    expect(markLabels({ state: "marked", markId: "m", landsIn: "subscription" }).button).toBe("Marked as a subscription · Unmark")
  })

  it("without landsIn (an older server), it's a subscription, as before", () => {
    expect(markLabels({ state: "markable" }).button).toBe("Mark as a subscription")
    expect(markLabels({ state: "detected" }).detected).toContain("under Subscriptions")
  })
})

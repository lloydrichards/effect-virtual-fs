import { assert, describe, it } from "@effect/vitest"
import { escapeBlock, escapeInline } from "../src/presentation.js"

describe("overlay presentation", () => {
  it("should escape terminal control characters when rendering model text", () => {
    assert.strictEqual(escapeInline("safe\n\u001b[2J"), "safe\\u{0a}\\u{1b}[2J")
    assert.strictEqual(escapeBlock("safe\n\u009b2J"), "safe\n\\u{9b}2J")
  })
})

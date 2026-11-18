import { assert, it } from "@effect/vitest"
import * as NodeProvider from "../src/index.js"
import * as NodeVirtualProvider from "../src/NodeVirtualProvider.js"

it("exposes NodeVirtualProvider through the package root", () => {
  assert.strictEqual(NodeProvider.NodeVirtualProvider, NodeVirtualProvider)
})

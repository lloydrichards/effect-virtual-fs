import { assert, it } from "@effect/vitest"
import { CheckpointError, CheckpointStore } from "../src/CheckpointStore.js"
import * as Persistence from "../src/index.js"

it("exposes the checkpoint service and error through the package root", () => {
  assert.strictEqual(Persistence.CheckpointStore, CheckpointStore)
  assert.strictEqual(Persistence.CheckpointError, CheckpointError)
})

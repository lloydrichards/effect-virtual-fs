import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import * as Memory from "../src/MemoryFileSystem.js"

const GUEST = { uid: 1, gid: 1, groups: [], privileged: false } as const

// A guest bound to a volume with a guest-owned /work, so permission checks apply as they do to an unprivileged
// Node process. Each expectation matches what Node does on a real filesystem.
const guest = Effect.gen(function*() {
  const volume = yield* Vfs.make()
  const owner = yield* Memory.bind(volume)
  yield* owner.makeDirectory("/work")
  yield* owner.chown("/work", GUEST.uid, GUEST.gid)

  return yield* Memory.bind(volume, { identity: GUEST })
})

describe("permission parity with Node", () => {
  it.effect("creates a recursive directory whose mode lacks owner search", () =>
    Effect.gen(function*() {
      const fs = yield* guest
      const outcome = yield* Effect.result(fs.makeDirectory("/work/sealed", { recursive: true, mode: 0o600 }))

      assert.isTrue(Result.isSuccess(outcome))
      assert.isTrue(yield* fs.exists("/work/sealed"))
    }))

  it.effect("still refuses a recursive directory over an existing file", () =>
    Effect.gen(function*() {
      const fs = yield* guest
      yield* fs.writeFileString("/work/file", "x")
      const error = yield* Effect.flip(fs.makeDirectory("/work/file", { recursive: true }))

      assert.strictEqual(error.reason._tag, "AlreadyExists")
    }))

  it.effect("removes a tree whose empty child directory has mode 000", () =>
    Effect.gen(function*() {
      const fs = yield* guest
      yield* fs.makeDirectory("/work/tree/sealed", { recursive: true })
      yield* fs.writeFileString("/work/tree/file", "x")
      yield* fs.chmod("/work/tree/sealed", 0o000)
      yield* fs.remove("/work/tree", { recursive: true })

      assert.isFalse(yield* fs.exists("/work/tree"))
    }))

  it.effect("refuses to remove a tree whose sealed child still holds entries", () =>
    Effect.gen(function*() {
      const fs = yield* guest
      yield* fs.makeDirectory("/work/tree/sealed", { recursive: true })
      yield* fs.writeFileString("/work/tree/sealed/file", "x")
      yield* fs.chmod("/work/tree/sealed", 0o000)
      const error = yield* Effect.flip(fs.remove("/work/tree", { recursive: true }))

      assert.strictEqual(error.reason._tag, "PermissionDenied")
    }))
})

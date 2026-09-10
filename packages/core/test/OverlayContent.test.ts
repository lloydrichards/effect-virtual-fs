import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"
import * as Content from "../src/internal/content.js"
import * as Image from "../src/internal/image.js"

describe("overlay content storage", () => {
  it.effect("should detach promoted content while untouched siblings keep sharing the immutable base payload", () =>
    Effect.gen(function*() {
      const base = yield* (yield* Vfs.fromFixture({
        entries: [{ kind: "file", path: "/file", bytes: new Uint8Array([1, 2, 3]) }]
      })).snapshot
      const image = yield* Image.inspect(base)
      assert.isFalse(Content.hasOverlayContents(base))
      assert.instanceOf(yield* Effect.flip(Vfs.makeOverlay(base, { maxBytes: -1 })), Vfs.ConfigurationError)
      assert.isFalse(Content.hasOverlayContents(base))
      assert.instanceOf(yield* Effect.flip(Vfs.makeOverlay(base, { maxBytes: 2 })), Vfs.ImageError)
      assert.isFalse(Content.hasOverlayContents(base))
      const first = Content.forOverlay(base, image)
      const second = Content.forOverlay(base, image)
      const file = image.records.find((record) => record.kind === "file")
      assert.isDefined(file)
      assert.strictEqual(first, second)
      assert.strictEqual(first.get(file.id), second.get(file.id))

      const workspaceA = yield* Vfs.makeOverlay(base)
      const workspaceB = yield* Vfs.makeOverlay(base)
      const a = yield* workspaceA.caller()
      const b = yield* workspaceB.caller()
      const handle = yield* a.open("/file", { access: "readWrite" })
      yield* handle.pwrite(new Uint8Array([7]), 0n)
      assert.deepStrictEqual(yield* b.readFile("/file"), new Uint8Array([1, 2, 3]))
      yield* b.chmod("/file", 0o600)
      assert.strictEqual(first, Content.forOverlay(base, image))
      // Deliberately violate the private immutable-content convention to prove
      // untouched workspaces still reference this exact cached payload.
      const shared = first.get(file.id)
      assert.isDefined(shared)
      shared.bytes[0] = 9
      assert.deepStrictEqual(yield* a.readFile("/file"), new Uint8Array([7, 2, 3]))
      assert.deepStrictEqual(yield* b.readFile("/file"), new Uint8Array([9, 2, 3]))
      assert.strictEqual((yield* b.stat("/file")).mode, 0o600)
    }))
})

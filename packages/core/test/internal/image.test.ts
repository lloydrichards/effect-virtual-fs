import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect } from "effect"
import * as Hex from "effect/encoding/Hex"
import { VirtualFileSystem as Vfs } from "../../src/index.js"
import { State } from "../../src/internal/engine.js"
import * as Image from "../../src/internal/image.js"

const { getNode, ROOT_INO } = State

describe("snapshot image base sharing", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should share unchanged snapshot content when independent workspaces are created",
      () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.fromFixture({
            entries: [{ kind: "file", path: "/file", bytes: new Uint8Array([1, 2, 3]) }]
          })

          const base = yield* volume.snapshot
          const first = yield* Image.valueOf(base)
          // Capture shares the volume's value, so an unchanged volume captures the same value again.
          assert.strictEqual(yield* Image.valueOf(yield* volume.snapshot), first)
          // @ts-expect-error exercises runtime rejection of a value outside the public ByteSize contract
          assert.instanceOf(yield* Effect.flip(Vfs.makeOverlay(base, { maxBytes: -1 })), Vfs.VfsError)
          assert.instanceOf(yield* Effect.flip(Vfs.makeOverlay(base, { maxBytes: ByteSize.bytes(2) })), Vfs.VfsError)

          const workspaceA = yield* Vfs.makeOverlay(base)
          const workspaceB = yield* Vfs.makeOverlay(base)
          const a = yield* workspaceA.caller()
          const b = yield* workspaceB.caller()
          const handle = yield* a.open("/file", { access: "readWrite" })
          yield* handle.pwrite(new Uint8Array([7]), 0n)
          assert.deepStrictEqual(yield* b.readFile("/file"), new Uint8Array([1, 2, 3]))
          yield* b.chmod("/file", 0o600)
          assert.strictEqual(yield* Image.valueOf(base), first)

          // Deliberately violate the private immutable-buffer convention to prove an untouched workspace still
          // reads the base value's exact payload while a promoted one holds its own.
          const rootNode = getNode(first, ROOT_INO)
          assert.isDefined(rootNode)
          assert.strictEqual(rootNode.kind, "directory")

          if (rootNode.kind !== "directory") return assert.fail("Expected directory root")
          const fileIno = rootNode?.entries.get(Hex.encode(new TextEncoder().encode("file")))
          assert.isDefined(fileIno)
          const fileNode = getNode(first, fileIno)
          assert.isDefined(fileNode)

          if (fileNode.kind !== "file") return assert.fail("Expected regular file")
          fileNode.data[0] = 9
          assert.deepStrictEqual(yield* a.readFile("/file"), new Uint8Array([7, 2, 3]))
          assert.deepStrictEqual(yield* b.readFile("/file"), new Uint8Array([9, 2, 3]))
          assert.strictEqual((yield* b.stat("/file")).mode, 0o600)
        })
    )
  })
})

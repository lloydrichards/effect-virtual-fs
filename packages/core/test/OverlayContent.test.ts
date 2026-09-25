import { assert, describe } from "@effect/vitest"
import { ByteSize, Effect, Encoding } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"
import * as Image from "../src/internal/image.js"
import * as InodeTable from "../src/internal/inodeTable.js"
import { baseStateFor, hasBaseState } from "../src/internal/virtualFileSystem.js"

import { it } from "./TestEffect.js"

describe("overlay base sharing", () => {
  it.effect(
    "should start every workspace from one restored base value that untouched siblings keep sharing",
    () =>
      Effect.gen(function*() {
        const base = yield* (yield* Vfs.fromFixture({
          entries: [{ kind: "file", path: "/file", bytes: new Uint8Array([1, 2, 3]) }]
        })).snapshot

        const image = yield* Image.inspect(base)
        assert.isFalse(hasBaseState(base))
        // @ts-expect-error exercises runtime rejection of a value outside the public ByteSize contract
        assert.instanceOf(yield* Effect.flip(Vfs.makeOverlay(base, { maxBytes: -1 })), Vfs.VfsError)
        assert.isFalse(hasBaseState(base))
        assert.instanceOf(yield* Effect.flip(Vfs.makeOverlay(base, { maxBytes: ByteSize.bytes(2) })), Vfs.VfsError)
        assert.isFalse(hasBaseState(base))

        const workspaceA = yield* Vfs.makeOverlay(base)
        assert.isTrue(hasBaseState(base))
        const first = yield* baseStateFor(base, image, 0n)
        const second = yield* baseStateFor(base, image, 0n)
        assert.strictEqual(first, second)

        const workspaceB = yield* Vfs.makeOverlay(base)
        const a = yield* workspaceA.caller()
        const b = yield* workspaceB.caller()
        const handle = yield* a.open("/file", { access: "readWrite" })
        yield* handle.pwrite(new Uint8Array([7]), 0n)
        assert.deepStrictEqual(yield* b.readFile("/file"), new Uint8Array([1, 2, 3]))
        yield* b.chmod("/file", 0o600)
        assert.strictEqual(first, yield* baseStateFor(base, image, 0n))

        // Deliberately violate the private immutable-payload convention to prove an untouched workspace still
        // reads the base value's exact payload while a promoted one holds its own.
        // SAFETY: the base value's inode shapes are private; the test reaches the file payload through them.
        const rootNode = InodeTable.get(first.inodes, 1) as { entries: ReadonlyMap<string, number> } | undefined
        const fileIno = rootNode?.entries.get(Encoding.encodeHex(new TextEncoder().encode("file")))
        assert.isDefined(fileIno)
        // SAFETY: as above.
        const fileNode = InodeTable.get(first.inodes, fileIno) as { data: { bytes: Uint8Array } } | undefined
        assert.isDefined(fileNode)
        fileNode.data.bytes[0] = 9
        assert.deepStrictEqual(yield* a.readFile("/file"), new Uint8Array([7, 2, 3]))
        assert.deepStrictEqual(yield* b.readFile("/file"), new Uint8Array([9, 2, 3]))
        assert.strictEqual((yield* b.stat("/file")).mode, 0o600)
      })
  )
})

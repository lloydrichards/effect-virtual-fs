import { assert, describe, it } from "@effect/vitest"
import { Effect, Predicate, Schema } from "effect"
import { BytePathId } from "../src/BytePath.js"
import { VirtualFileSystem as Vfs } from "../src/index.js"
import { entryNames, text } from "./support/text.js"

describe("fixtures", () => {
  it("should reject objects that forge the public BytePath symbol when a caller supplies a forged BytePath", () => {
    const forged = Object.freeze({ [BytePathId]: BytePathId })

    const decoded = Schema.decodeUnknownResult(Vfs.Fixture)({
      entries: [{ kind: "directory", path: forged }]
    })

    assert.isTrue(Predicate.isTagged("Failure")(decoded))
  })

  it.effect(
    "should load order-independent fixtures with forward hard links and fixed metadata when a fixture contains forward hard links",
    () =>
      Effect.gen(function*() {
        const input = new Uint8Array([1, 2])

        const volume = yield* Vfs.fromFixture({
          entries: [
            { kind: "hardLink", path: "/alias", target: "/dir/file" },
            { kind: "file", path: "/dir/file", bytes: input, metadata: { mode: 0o640, uid: 7 } },
            { kind: "directory", path: "/dir" },
            { kind: "symlink", path: "/dangling", target: "absent" }
          ]
        })

        input[0] = 9
        const fs = yield* volume.caller()
        const f = yield* fs.open("/alias", { access: "read" })
        assert.deepStrictEqual(yield* f.read(2), new Uint8Array([1, 2]))
        const stat = yield* fs.stat("/dir/file")
        assert.strictEqual(stat.ino, (yield* f.stat).ino)
        assert.deepStrictEqual([stat.nlink, stat.uid, stat.mode, stat.mtimeNs], [2, 7, 0o640, 0n])
        assert.strictEqual(text(yield* fs.readLink("/dangling")), "absent")
      })
  )

  it.effect("should list a fixture's entries in the byte order of their names whatever order declares them when fixture entries are declared out of order", () =>
    Effect.gen(function*() {
      const entries: Array<Vfs.Fixture["entries"][number]> = [
        { kind: "file", path: "/b", bytes: new Uint8Array() },
        { kind: "directory", path: "/c" },
        { kind: "symlink", path: "/a", target: "b" },
        { kind: "hardLink", path: "/B", target: "/b" }
      ]

      for (const declared of [entries, [...entries].reverse()]) {
        const fs = yield* (yield* Vfs.fromFixture({ entries: declared })).caller()
        assert.deepStrictEqual(entryNames(yield* fs.readDirectory("/")), ["B", "a", "b", "c"])
      }
    }))

  it.effect(
    "should capture independent byte views when fixture construction is executed again",
    () =>
      Effect.gen(function*() {
        const input = new Uint8Array([0, 1, 2, 0])
        const construct = Vfs.fromFixture({ entries: [{ kind: "file", path: "/f", bytes: input.subarray(1, 3) }] })
        input[1] = 3
        const first = yield* (yield* construct).caller()
        input[1] = 4
        const second = yield* (yield* construct).caller()
        input.fill(0)
        assert.deepStrictEqual(yield* first.readFile("/f"), new Uint8Array([3, 2]))
        assert.deepStrictEqual(yield* second.readFile("/f"), new Uint8Array([4, 2]))
        yield* first.writeFile("/f", new Uint8Array([9]), { access: "write", truncate: true })
        assert.deepStrictEqual(yield* second.readFile("/f"), new Uint8Array([4, 2]))
      })
  )
})

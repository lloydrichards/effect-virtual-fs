import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect, Option, Stream } from "effect"
import type { FixtureEntry } from "../../src/Fixture.js"
import { VirtualFileSystem as Vfs } from "../../src/index.js"
import * as Image from "../../src/internal/image.js"
import { makeVisitor, type Visitor } from "../../src/internal/search.js"
import { defaults, makeMeter } from "../../src/internal/searchModel.js"

const bytes = new TextEncoder().encode("content")

const selectAll = () => Effect.succeed({ selected: true, prune: false })

const collect = Effect.fnUntraced(function*(visitor: Visitor) {
  const paths: Array<string> = []

  for (let entry = yield* visitor.next(selectAll); entry !== undefined; entry = yield* visitor.next(selectAll)) {
    paths.push(entry.path)
  }

  return paths
})

const snapshot = Effect.fnUntraced(function*(entries: ReadonlyArray<FixtureEntry>) {
  return yield* (yield* Vfs.fromFixture({ entries })).snapshot
})

describe("immutable search visitor", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect("follows root links while retaining snapshotEntries final-link behavior and typed root errors", () =>
      Effect.gen(function*() {
        const image = yield* snapshot([
          { kind: "directory", path: "/dir" },
          { kind: "file", path: "/dir/file", bytes },
          { kind: "symlink", path: "/via", target: "dir" },
          { kind: "symlink", path: "/loop", target: "loop" }
        ])

        assert.deepStrictEqual(yield* collect(yield* makeVisitor(image, "/via", makeMeter(defaults))), ["file"])
        const old = yield* Stream.runHead(Image.snapshotEntries(image, "/via"))
        assert.strictEqual(Option.getOrThrow(old).kind, "symlink")

        for (
          const [root, code] of [["/missing", "NotFound"], ["/dir/file", "NotDirectory"], ["/loop", "SymlinkLoop"]]
        ) {
          const error = yield* Effect.flip(makeVisitor(image, root!, makeMeter(defaults)))
          assert.strictEqual(error.code, code)
        }
      }))

    it.effect("visits byte-sorted depth-first paths including every alias without following discovered links", () =>
      Effect.gen(function*() {
        const image = yield* snapshot([
          { kind: "directory", path: "/a" },
          { kind: "file", path: "/a/child", bytes },
          { kind: "file", path: "/a.txt", bytes },
          { kind: "hardLink", path: "/alias", target: "/a/child" },
          { kind: "symlink", path: "/link", target: "a" },
          { kind: "file", path: "/😀", bytes }
        ])

        const meter = makeMeter(defaults)
        assert.deepStrictEqual(yield* collect(yield* makeVisitor(image, "/", meter)), [
          "a",
          "a/child",
          "a.txt",
          "alias",
          "link",
          "😀"
        ])
        assert.strictEqual(meter.work.entries, 6)
        assert.strictEqual(meter.work.scannedBytes, ByteSize.bytes(0))
      }))

    it.effect("returns a selected directory before preparing children and reserves pending siblings against width", () =>
      Effect.gen(function*() {
        const image = yield* snapshot([
          { kind: "directory", path: "/a" },
          { kind: "file", path: "/a/one", bytes },
          { kind: "file", path: "/a/two", bytes },
          { kind: "file", path: "/z", bytes }
        ])

        const meter = makeMeter({ ...defaults, maxEntries: 3 })
        const visitor = yield* makeVisitor(image, "/", meter)
        assert.strictEqual((yield* visitor.next(selectAll))?.path, "a")
        assert.strictEqual(meter.work.entries, 1)
        const stopped = yield* Effect.flip(visitor.next(selectAll))
        assert.strictEqual(stopped.limit, "maxEntries")
        assert.strictEqual(stopped.path, "a")
        assert.strictEqual(meter.work.entries, 1)
        const wideMeter = makeMeter({ ...defaults, maxEntries: 1 })
        const wide = yield* makeVisitor(image, "/", wideMeter)
        assert.strictEqual(wideMeter.work.entries, 0)
        assert.strictEqual((yield* Effect.flip(wide.next(selectAll))).limit, "maxEntries")
        assert.strictEqual(wideMeter.work.entries, 0)
      }))

    it.effect("prunes exclusions and invalid-name subtrees without counting unseen descendants", () =>
      Effect.gen(function*() {
        const invalid = yield* Vfs.pathFromBytes(new Uint8Array([47, 255]))
        const invalidChild = yield* Vfs.pathFromBytes(new Uint8Array([47, 255, 47, 120]))

        const image = yield* snapshot([
          { kind: "directory", path: invalid },
          { kind: "file", path: invalidChild, bytes },
          { kind: "directory", path: "/excluded" },
          { kind: "file", path: "/excluded/child", bytes },
          { kind: "file", path: "/keep", bytes }
        ])

        const meter = makeMeter(defaults)
        const visitor = yield* makeVisitor(image, "/", meter)
        const paths: Array<string> = []

        const select = (entry: { readonly path: string }) =>
          Effect.succeed({ selected: entry.path !== "excluded", prune: entry.path === "excluded" })

        for (let entry = yield* visitor.next(select); entry !== undefined; entry = yield* visitor.next(select)) {
          paths.push(entry.path)
        }

        assert.deepStrictEqual(paths, ["keep"])
        assert.strictEqual(meter.work.entries, 3)
        assert.strictEqual(meter.skips.invalidNames, 1)
        assert.strictEqual(meter.skips.invalidNameSubtrees, 1)
      }))

    it.effect("stops at depth and UTF-8 path boundaries while empty directories need no deeper work", () =>
      Effect.gen(function*() {
        const image = yield* snapshot([{ kind: "directory", path: "/a" }, { kind: "file", path: "/a/😀", bytes }])

        for (const limits of [{ ...defaults, maxDepth: 1 }, { ...defaults, maxPathBytes: ByteSize.bytes(5) }]) {
          const visitor = yield* makeVisitor(image, "/", makeMeter(limits))
          assert.strictEqual((yield* visitor.next(selectAll))?.path, "a")
          assert.strictEqual(
            (yield* Effect.flip(visitor.next(selectAll))).limit,
            limits.maxDepth === 1 ? "maxDepth" : "maxPathBytes"
          )
        }

        const exact = yield* makeVisitor(image, "/", makeMeter({ ...defaults, maxPathBytes: ByteSize.bytes(6) }))
        yield* exact.next(selectAll)
        assert.strictEqual((yield* exact.next(selectAll))?.pathBytes, 6)
        const empty = yield* snapshot([{ kind: "directory", path: "/a" }])
        assert.deepStrictEqual(
          yield* collect(yield* makeVisitor(empty, "/", makeMeter({ ...defaults, maxDepth: 1 }))),
          ["a"]
        )
      }))

    it.effect("does not access or copy file payloads when visiting immutable nodes", () =>
      Effect.gen(function*() {
        const image = yield* snapshot([{ kind: "file", path: "/file", bytes }])
        const value = yield* Image.valueOf(image)

        const file = yield* Effect.fromResult(
          Image.resolve(value, "/file", { operation: "test", followFinalSymlink: true })
        )

        if (file.kind !== "file") return assert.fail("expected file")
        Object.defineProperty(file, "data", {
          get: () => {
            throw new Error("payload read")
          }
        })
        assert.deepStrictEqual(yield* collect(yield* makeVisitor(image, "/", makeMeter(defaults))), ["file"])
      }))
  })
})

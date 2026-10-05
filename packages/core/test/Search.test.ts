import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Deferred, Effect, Exit, Fiber, Layer, Predicate, Schema, Stream } from "effect"
import type { FixtureEntry } from "../src/Fixture.js"
import { LiveVolume, Testing, VirtualFileSystem as Vfs } from "../src/index.js"
import * as Image from "../src/internal/image.js"
import * as InodeTable from "../src/internal/inodeTable.js"
import { getNode, ROOT_INO } from "../src/internal/volumeState.js"
import * as Search from "../src/Search.js"

const file = (path: string): FixtureEntry => ({ kind: "file", path, bytes: new Uint8Array([255, 0, 128]) })

const snapshotOf = Effect.fnUntraced(function*(entries: ReadonlyArray<FixtureEntry>) {
  return yield* (yield* Vfs.fromFixture({ entries })).snapshot
})

const all = { root: "/", include: ["**"] } as const

describe("snapshot filename search", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect("includes hidden names and all kinds in raw-byte depth-first preorder", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([
          file("/z"),
          file("/😀"),
          file("/\uE000"),
          { kind: "directory", path: "/a" },
          file("/a/z"),
          file("/a.txt"),
          file("/.hidden"),
          { kind: "symlink", path: "/link", target: "/a" }
        ])

        const report = yield* Search.glob(snapshot, all)
        assert.deepStrictEqual(report.results, [".hidden", "a", "a/z", "a.txt", "link", "z", "\uE000", "😀"])
        assert.deepStrictEqual(report.completion, { _tag: "Complete" })
        assert.strictEqual(report.work.entries, 8)
        assert.strictEqual(report.work.scannedBytes, ByteSize.bytes(0))
        assert.strictEqual(report.work.lineEvaluations, 0)
        assert.strictEqual(report.root, "/")
        assert.deepStrictEqual((yield* Search.glob(snapshot, { ...all, kinds: ["symlink"] })).results, ["link"])
        assert.deepStrictEqual((yield* Search.glob(snapshot, { ...all, kinds: ["directory"] })).results, ["a"])
        assert.deepStrictEqual((yield* Search.glob(snapshot, { ...all, kinds: [] })).results, [])
      }))

    it.effect("matches one Unicode scalar and numerical code-point class ranges without normalizing text", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([
          file("/😀.ts"),
          file("/😁.ts"),
          file("/ab.ts"),
          file("/é"),
          file("/é"),
          file("/*"),
          file("/{x}"),
          file("/a.js")
        ])

        assert.deepStrictEqual((yield* Search.glob(snapshot, { ...all, include: ["?.ts"] })).results, [
          "😀.ts",
          "😁.ts"
        ])
        assert.deepStrictEqual((yield* Search.glob(snapshot, { ...all, include: ["[😀-😁].ts"] })).results, [
          "😀.ts",
          "😁.ts"
        ])
        assert.deepStrictEqual((yield* Search.glob(snapshot, { ...all, include: ["[!😀].ts"] })).results, ["😁.ts"])
        assert.deepStrictEqual(
          (yield* Search.glob(snapshot, { ...all, include: ["\\*", "\\{x\\}", "a.{js,ts}"] })).results,
          ["*", "a.js", "{x}"]
        )
        assert.deepStrictEqual((yield* Search.glob(snapshot, { ...all, include: ["é"] })).results, ["é"])
        assert.deepStrictEqual((yield* Search.glob(snapshot, { ...all, include: ["?"] })).results, ["*", "é"])
      }))

    it.effect("should accept deeply nested alternatives when they fit the default compiler allowance", () =>
      Effect.gen(function*() {
        let nested = "z"

        for (let index = 0; index < 11; index++) nested = `{a${index},${nested}}`

        const report = yield* snapshotOf([file("/z")]).pipe(
          Effect.flatMap(Search.glob({ ...all, include: [nested] }))
        )

        assert.deepStrictEqual(report.results, ["z"])
        assert.strictEqual(report.completion._tag, "Complete")
      }))

    it.effect("filters result kinds without pruning includes and prunes excluded directories", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([
          { kind: "directory", path: "/keep" },
          { kind: "directory", path: "/drop" },
          file("/keep/a.ts"),
          file("/drop/a.ts"),
          file("/root.ts"),
          { kind: "symlink", path: "/keep/link.ts", target: "/drop" }
        ])

        const report = yield* Search.glob(snapshot, {
          ...all,
          include: ["**/*.ts"],
          exclude: ["drop/"],
          kinds: ["file"]
        })

        assert.deepStrictEqual(report.results, ["keep/a.ts", "root.ts"])
        assert.strictEqual(report.work.entries, 5)
        assert.deepStrictEqual((yield* Search.glob(snapshot, { ...all, include: ["keep/"] })).results, ["keep"])
      }))

    it.effect("considers each hard-link name even when its earlier alias is excluded", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([file("/a"), { kind: "hardLink", path: "/b", target: "/a" }, {
          kind: "directory",
          path: "/dir"
        }, { kind: "hardLink", path: "/dir/c", target: "/a" }])

        assert.deepStrictEqual((yield* Search.glob(snapshot, { ...all, kinds: ["file"] })).results, ["a", "b", "dir/c"])
        assert.deepStrictEqual((yield* Search.glob(snapshot, { ...all, exclude: ["a"], kinds: ["file"] })).results, [
          "b",
          "dir/c"
        ])
      }))

    it.effect("counts invalid names and one unrepresentable subtree without visiting its descendants", () =>
      Effect.gen(function*() {
        const badDirectory = yield* Vfs.pathFromBytes(new Uint8Array([47, 255]))
        const descendant = yield* Vfs.pathFromBytes(new Uint8Array([47, 255, 47, 120]))
        const badFile = yield* Vfs.pathFromBytes(new Uint8Array([47, 254]))
        const badLink = yield* Vfs.pathFromBytes(new Uint8Array([47, 253]))

        const snapshot = yield* snapshotOf([
          { kind: "directory", path: badDirectory },
          { kind: "file", path: descendant, bytes: new Uint8Array() },
          { kind: "file", path: badFile, bytes: new Uint8Array() },
          { kind: "symlink", path: badLink, target: "/ok" },
          file("/ok")
        ])

        const report = yield* Search.glob(snapshot, all)
        assert.deepStrictEqual(report.results, ["ok"])
        assert.strictEqual(report.work.entries, 4)
        assert.deepStrictEqual(report.skips, {
          invalidNames: 3,
          invalidNameSubtrees: 1,
          oversizedFiles: 0,
          invalidUtf8Files: 0,
          binaryFiles: 0
        })
        assert.strictEqual(report.completion._tag, "Complete")
      }))

    it.effect("follows the selected root symlink and leaves discovered links as single entries", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([{ kind: "directory", path: "/real" }, file("/real/f"), {
          kind: "symlink",
          path: "/real/cycle",
          target: "/real"
        }, { kind: "symlink", path: "/alias", target: "/real" }])

        const report = yield* Search.glob(snapshot, { ...all, root: "/alias" })
        assert.deepStrictEqual(report.results, ["cycle", "f"])
        assert.strictEqual(report.root, "/alias")
        const missing = yield* Effect.flip(Search.glob(snapshot, { ...all, root: "/missing" }))
        assert.isTrue("code" in missing && missing.code === "NotFound")
        const notDirectory = yield* Effect.flip(Search.glob(snapshot, { ...all, root: "/real/f" }))
        assert.isTrue("code" in notDirectory && notDirectory.code === "NotDirectory")
      }))

    it.effect("rejects malformed selectors and compiler bounds before looking up the root", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([])

        for (const pattern of ["", "/a", "a//b", "a/../b", "[", "[z-a]", "{a,b", "x**", "a\\", "\uD800", "a\0b"]) {
          const error = yield* Effect.flip(Search.glob(snapshot, { root: "/missing", include: [pattern] }))
          assert.instanceOf(error, Search.QueryFailure)
        }

        for (
          const limits of [
            { maxPatterns: 0 },
            { maxPatternBytes: ByteSize.bytes(0) },
            { maxPatternListBytes: ByteSize.bytes(0) },
            { maxExpansions: 0 },
            { maxTokens: 0 }
          ]
        ) {
          assert.instanceOf(
            yield* Effect.flip(Search.glob(snapshot, { root: "/missing", include: ["a"], limits })),
            Search.QueryFailure
          )
        }

        for (const maxEntries of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
          assert.instanceOf(
            yield* Effect.flip(Search.glob(snapshot, { ...all, limits: { maxEntries } })),
            Search.QueryFailure
          )
        }
      }))

    it.effect("stops exactly at the result cap even when no later match exists", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([file("/a"), file("/b")])
        const report = yield* Search.glob(snapshot, { ...all, limits: { maxResults: 2 } })
        assert.deepStrictEqual(report.results, ["a", "b"])
        assert.deepStrictEqual(report.completion, { _tag: "Stopped", limit: "maxResults", path: "b" })
        const zero = yield* Search.glob(snapshot, { ...all, limits: { maxResults: 0 } })
        assert.deepStrictEqual(zero.results, [])
        assert.strictEqual(zero.work.entries, 0)
        assert.deepStrictEqual(zero.completion, { _tag: "Stopped", limit: "maxResults", path: "" })

        const missing = yield* Effect.flip(
          Search.glob(snapshot, { ...all, root: "/missing", limits: { maxResults: 0 } })
        )

        assert.isTrue("code" in missing && missing.code === "NotFound")
      }))

    it.effect("charges exact UTF-8 path bytes and preserves rows before a payload stop", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([file("/a"), file("/😀")])
        const report = yield* Search.glob(snapshot, { ...all, limits: { maxResultBytes: ByteSize.bytes(4) } })
        assert.deepStrictEqual(report.results, ["a"])
        assert.strictEqual(report.work.resultBytes, ByteSize.bytes(1))
        assert.deepStrictEqual(report.completion, { _tag: "Stopped", limit: "maxResultBytes", path: "😀" })
        const fit = yield* Search.glob(snapshot, { ...all, limits: { maxResultBytes: ByteSize.bytes(5) } })
        assert.strictEqual(fit.completion._tag, "Complete")
        assert.strictEqual(fit.work.resultBytes, ByteSize.bytes(5))
      }))

    it.effect("preflights directory width including already prepared siblings", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([{ kind: "directory", path: "/a" }, file("/a/x"), file("/a/y"), file("/b")])
        const tooWide = yield* Search.glob(snapshot, { ...all, limits: { maxEntries: 1 } })
        assert.deepStrictEqual(tooWide.results, [])
        assert.strictEqual(tooWide.work.entries, 0)
        assert.deepStrictEqual(tooWide.completion, { _tag: "Stopped", limit: "maxEntries", path: "" })
        const pending = yield* Search.glob(snapshot, { ...all, limits: { maxEntries: 3 } })
        assert.deepStrictEqual(pending.results, ["a"])
        assert.strictEqual(pending.work.entries, 1)
        assert.deepStrictEqual(pending.completion, { _tag: "Stopped", limit: "maxEntries", path: "a" })
        assert.deepStrictEqual((yield* Search.glob(snapshot, { ...all, limits: { maxEntries: 4 } })).results, [
          "a",
          "a/x",
          "a/y",
          "b"
        ])
      }))

    it.effect("stops an oversized directory before reading its child list", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([file("/a"), file("/b")])
        const state = yield* Image.valueOf(snapshot)
        const root = getNode(state, ROOT_INO)!

        if (root.kind !== "directory") return assert.fail("Expected directory root")

        const entries = new Proxy(root.entries, {
          get(target, property) {
            if (
              property === Symbol.iterator || property === "entries" || property === "keys" || property === "values"
            ) {
              throw new Error("Search materialized an oversized directory")
            }

            return property === "size" ? target.size : undefined
          }
        })

        const guarded = Image.make({ ...state, inodes: InodeTable.set(state.inodes, ROOT_INO, { ...root, entries }) })
        const report = yield* Search.glob(guarded, { ...all, limits: { maxEntries: 1 } })
        assert.deepStrictEqual(report.results, [])
        assert.strictEqual(report.work.entries, 0)
        assert.deepStrictEqual(report.completion, { _tag: "Stopped", limit: "maxEntries", path: "" })
      }))

    it.effect("yields during unmatched traversal so an evaluation can be interrupted before exhaustion", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf(Array.from({ length: 1024 }, (_, index) => file(`/f${index}`)))
        const state = yield* Image.valueOf(snapshot)
        const root = getNode(state, ROOT_INO)!

        if (root.kind !== "directory") return assert.fail("Expected directory root")
        let observed = 0
        let inodes = state.inodes

        for (const ino of root.entries.values()) {
          const node = getNode(state, ino)!
          inodes = InodeTable.set(
            inodes,
            ino,
            new Proxy(node, {
              get(target, property) {
                if (property === "kind") observed++

                return Object.getOwnPropertyDescriptor(target, property)?.value
              }
            })
          )
        }

        const guarded = Image.make({ ...state, inodes })

        const scanning = yield* Search.glob(guarded, { ...all, include: ["never"] }).pipe(
          Effect.forkChild({ startImmediately: true })
        )

        yield* Fiber.interrupt(scanning)
        assert.isTrue(Exit.isFailure(yield* Fiber.await(scanning)))
        assert.isTrue(observed > 0)
        assert.isTrue(observed < 1024)
        assert.deepStrictEqual((yield* Search.glob(snapshot, { ...all, include: ["never"] })).completion, {
          _tag: "Complete"
        })
      }))

    it.effect("stops before extending depth or raw path bounds and counts rejected entries", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([{ kind: "directory", path: "/a" }, file("/a/x"), file("/b")])
        const depth = yield* Search.glob(snapshot, { ...all, include: ["never"], limits: { maxDepth: 1 } })
        assert.strictEqual(depth.completion._tag, "Stopped")

        if (Predicate.isTagged("Stopped")(depth.completion)) assert.strictEqual(depth.completion.limit, "maxDepth")
        assert.deepStrictEqual(depth.results, [])
        assert.strictEqual(depth.work.entries, 2)
        const path = yield* Search.glob(snapshot, { ...all, limits: { maxPathBytes: ByteSize.bytes(2) } })
        assert.deepStrictEqual(path.results, ["a"])
        assert.strictEqual(path.completion._tag, "Stopped")

        if (Predicate.isTagged("Stopped")(path.completion)) assert.strictEqual(path.completion.limit, "maxPathBytes")
        const emptyDirectory = yield* snapshotOf([{ kind: "directory", path: "/a" }])
        assert.strictEqual(
          (yield* Search.glob(emptyDirectory, { ...all, limits: { maxDepth: 1 } })).completion._tag,
          "Complete"
        )
      }))

    it.effect("exposes matching-work exhaustion without exceeding the configured budget", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([file("/abc")])
        const report = yield* Search.glob(snapshot, { ...all, include: ["[a-z]*"], limits: { maxMatchingWork: 0 } })
        assert.deepStrictEqual(report.results, [])
        assert.strictEqual(report.work.matchingWork, 0)
        assert.strictEqual(report.completion._tag, "Stopped")

        if (Predicate.isTagged("Stopped")(report.completion)) {
          assert.strictEqual(report.completion.limit, "maxMatchingWork")
        }

        assert.instanceOf(
          yield* Effect.flip(Stream.runCollect(Search.scanGlob(snapshot, { ...all, limits: { maxMatchingWork: 0 } }))),
          Search.BudgetExceeded
        )
      }))

    it.effect("emits a deterministic prefix then fails its Stream while the collector retains it", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([
          { kind: "directory", path: "/a" },
          file("/a/z"),
          file("/a.txt"),
          file("/b")
        ])

        const query = { ...all, limits: { maxResults: 2 } }
        const rows: Array<string> = []

        const error = yield* Effect.flip(
          Stream.runForEach(Search.scanGlob(snapshot, query), (row) =>
            Effect.sync(() => {
              rows.push(row)
            }))
        )

        assert.deepStrictEqual(rows, ["a", "a/z"])
        assert.instanceOf(error, Search.BudgetExceeded)

        if (Schema.is(Search.BudgetExceeded)(error)) assert.strictEqual(error.limit, "maxResults")
        assert.deepStrictEqual((yield* Search.glob(snapshot, query)).results, rows)
        assert.deepStrictEqual(yield* Stream.runCollect(Stream.take(Search.scanGlob(snapshot, query), 2)), rows)
      }))

    it.effect("starts fresh counters and traversal for repeated and concurrent Effects and Streams", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([file("/a"), file("/b")])
        const effect = Search.glob(snapshot, { ...all, limits: { maxResults: 1 } })
        const first = yield* effect
        assert.deepStrictEqual(yield* effect, first)
        assert.deepStrictEqual(yield* Effect.all([effect, effect], { concurrency: "unbounded" }), [first, first])
        const stream = Search.scanGlob(snapshot, all)
        assert.deepStrictEqual(
          yield* Effect.all([Stream.runCollect(stream), Stream.runCollect(stream)], { concurrency: "unbounded" }),
          [["a", "b"], ["a", "b"]]
        )
      }))

    it.effect("searches the captured namespace after live edits and searches merged overlay snapshots", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.fromFixture({ entries: [file("/kept"), file("/removed")] })
        const snapshot = yield* volume.snapshot
        const caller = yield* volume.caller()
        yield* caller.unlink("/removed")
        yield* caller.writeFile("/new", new Uint8Array(), { access: "write", create: "exclusive" })
        assert.deepStrictEqual((yield* Search.glob(snapshot, all)).results, ["kept", "removed"])
        assert.deepStrictEqual((yield* Search.glob(yield* volume.snapshot, all)).results, ["kept", "new"])
        const overlay = yield* Vfs.makeOverlay(snapshot)
        const workspace = yield* overlay.caller()
        yield* workspace.unlink("/removed")
        yield* workspace.writeFile("/overlay", new Uint8Array(), { access: "write", create: "exclusive" })
        assert.deepStrictEqual((yield* Search.glob(yield* overlay.snapshot, all)).results, ["kept", "overlay"])
        assert.deepStrictEqual((yield* Search.glob(snapshot, all)).results, ["kept", "removed"])
      }))

    it.effect("accepts paths exactly at the UTF-8 byte bound and stops before exceeding it", () =>
      Effect.gen(function*() {
        const emoji = yield* snapshotOf([file("/😀")])
        const exact = yield* Search.glob(emoji, { ...all, limits: { maxPathBytes: ByteSize.bytes(4) } })
        assert.deepStrictEqual(exact.results, ["😀"])
        assert.strictEqual(exact.completion._tag, "Complete")
        const stopped = yield* Search.glob(emoji, { ...all, limits: { maxPathBytes: ByteSize.bytes(3) } })
        assert.deepStrictEqual(stopped.results, [])
        assert.deepStrictEqual(stopped.completion, { _tag: "Stopped", limit: "maxPathBytes", path: "" })
        const nested = yield* snapshotOf([{ kind: "directory", path: "/a" }, file("/a/x")])
        const fitting = yield* Search.glob(nested, { ...all, limits: { maxPathBytes: ByteSize.bytes(3) } })
        assert.deepStrictEqual(fitting.results, ["a", "a/x"])
        assert.strictEqual(fitting.completion._tag, "Complete")
      }))

    it.effect("never accesses file payloads even when selected contents are invalid, binary or oversized", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([file("/f")])
        const state = yield* Image.valueOf(snapshot)
        const root = getNode(state, ROOT_INO)!
        assert.strictEqual(root.kind, "directory")

        if (root.kind !== "directory") return
        const ino = root.entries.values().next().value!
        const node = getNode(state, ino)!
        assert.strictEqual(node.kind, "file")

        if (node.kind !== "file") return

        const guarded = new Proxy(node, {
          get(target, property) {
            if (property === "data") throw new Error("Glob touched file payload")

            return Object.getOwnPropertyDescriptor(target, property)?.value
          }
        })

        const protectedSnapshot = Image.make({ ...state, inodes: InodeTable.set(state.inodes, ino, guarded) })

        const report = yield* Search.glob(protectedSnapshot, {
          ...all,
          limits: { maxFileBytes: ByteSize.bytes(0), maxScannedBytes: ByteSize.bytes(0) }
        })

        assert.deepStrictEqual(report.results, ["f"])
        assert.strictEqual(report.work.scannedBytes, ByteSize.bytes(0))
        assert.strictEqual(report.skips.oversizedFiles, 0)
        assert.strictEqual(report.skips.invalidUtf8Files, 0)
        assert.strictEqual(report.skips.binaryFiles, 0)
        assert.deepStrictEqual(yield* Stream.runCollect(Search.scanGlob(protectedSnapshot, all)), ["f"])
      }))

    it.effect("leaves metadata, revisions, watches and durable commits unchanged on success, stops, failure and interruption", () => {
      let commits = 0

      const store = Layer.succeed(
        LiveVolume.LiveImageStore,
        LiveVolume.LiveImageStore.of({
          loadOrCreate: Effect.succeed,
          commit: () =>
            Effect.sync(() => {
              commits++

              return "committed" as const
            })
        })
      )

      return Effect.gen(function*() {
        const volume = yield* LiveVolume.open({ maxImageBytes: ByteSize.megabytes(1), volume: {} })
        const caller = yield* volume.caller()
        yield* caller.writeFile("/f", new Uint8Array([1]), { access: "write", create: "exclusive" })
        const snapshot = yield* volume.snapshot
        const before = yield* caller.stat("/f")
        const rootBefore = yield* caller.stat("/")
        const committed = commits
        const changes = yield* Testing.collectChanges(yield* volume.watch(), 1)
        yield* Search.glob(snapshot, all)
        yield* Search.glob(snapshot, { ...all, limits: { maxResults: 0 } })
        yield* Effect.flip(Search.glob(snapshot, { ...all, include: ["["] }))
        yield* Effect.flip(Search.glob(snapshot, { ...all, root: "/missing" }))
        const delivered = yield* Deferred.make<void>()

        const scanning = yield* Stream.runForEach(
          Search.scanGlob(snapshot, all),
          () => Deferred.succeed(delivered, undefined).pipe(Effect.andThen(Effect.never))
        ).pipe(Effect.forkChild({ startImmediately: true }))

        yield* Deferred.await(delivered)
        yield* Fiber.interrupt(scanning)
        const interrupted = yield* Fiber.await(scanning)
        assert.isTrue(Exit.isFailure(interrupted))
        assert.deepStrictEqual(yield* caller.stat("/f"), before)
        assert.deepStrictEqual(yield* caller.stat("/"), rootBefore)
        assert.strictEqual(commits, committed)
        yield* caller.mkdir("/sentinel")
        const events = yield* changes
        assert.strictEqual(events.length, 1)
        assert.strictEqual(events[0]!._tag, "Create")
        assert.deepStrictEqual(yield* Vfs.pathToBytes(events[0]!.path), new TextEncoder().encode("/sentinel"))
      }).pipe(Effect.provide(store))
    })
  })
})

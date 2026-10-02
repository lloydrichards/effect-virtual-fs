import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Deferred, Effect, Exit, Fiber, Layer, Predicate, Stream } from "effect"
import type { FixtureEntry } from "../src/Fixture.js"
import { LiveVolume, Testing, VirtualFileSystem as Vfs } from "../src/index.js"
import * as Image from "../src/internal/image.js"
import * as InodeTable from "../src/internal/inodeTable.js"
import { getNode, ROOT_INO } from "../src/internal/volumeState.js"
import * as Search from "../src/Search.js"

const encoder = new TextEncoder()

const file = (path: string, text: string): FixtureEntry => ({ kind: "file", path, bytes: encoder.encode(text) })

const snapshotOf = Effect.fnUntraced(function*(entries: ReadonlyArray<FixtureEntry>) {
  return yield* (yield* Vfs.fromFixture({ entries })).snapshot
})

const literal = (pattern: string) => Search.Pattern.cases.Literal.make({ pattern })

const regex = (pattern: string) => Search.Pattern.cases.Regex.make({ pattern })

const query = { root: "/", include: ["**"], pattern: literal("hit") } as const

const rows = (path: string, lineNumber: number, start: number, end: number, text: string, truncated = false) => ({
  path,
  lineNumber,
  range: { start, end },
  excerpt: { text, start, truncated }
})

describe("snapshot content search", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect("classifies whole files before all modes expose matching prefixes", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([
          file("/a", "hit hit\nmiss\nhit\n"),
          { kind: "file", path: "/binary", bytes: new Uint8Array([...encoder.encode("hit\n"), 0]) },
          { kind: "file", path: "/invalid", bytes: new Uint8Array([...encoder.encode("hit\n"), 0, 255]) },
          file("/empty", "")
        ])

        const lines = yield* Search.lines(snapshot, query)
        const files = yield* Search.files(snapshot, query)
        const counts = yield* Search.countLines(snapshot, query)
        assert.deepStrictEqual(lines.results, [rows("a", 1, 0, 3, "hit hit"), rows("a", 3, 13, 16, "hit")])
        assert.deepStrictEqual(files.results, ["a"])
        assert.deepStrictEqual(counts.results, [{ path: "a", count: 2 }])

        for (const report of [lines, files, counts]) {
          assert.strictEqual(report.skips.invalidUtf8Files, 1)
          assert.strictEqual(report.skips.binaryFiles, 1)
          assert.strictEqual(report.work.scannedBytes, ByteSize.bytes(28))
          assert.strictEqual(report.completion._tag, "Complete")
        }

        assert.deepStrictEqual(yield* Stream.runCollect(Search.scanLines(snapshot, query)), lines.results)
        assert.deepStrictEqual(yield* Stream.runCollect(Search.scanFiles(snapshot, query)), files.results)
        assert.deepStrictEqual(yield* Stream.runCollect(Search.scanCountLines(snapshot, query)), counts.results)
        assert.strictEqual(files.work.lineEvaluations, 1)
        assert.strictEqual(counts.work.lineEvaluations, 3)
      }))

    it.effect("rejects every malformed UTF-8 sequence while accepting scalar boundary values", () =>
      Effect.gen(function*() {
        const invalid = [
          [0xc0, 0x80],
          [0xe0, 0x80, 0x80],
          [0xed, 0xa0, 0x80],
          [0xf0, 0x80, 0x80, 0x80],
          [0xf4, 0x90, 0x80, 0x80],
          [0xf5, 0x80, 0x80, 0x80],
          [0x80],
          [0xc2, 0x20],
          [0xe1, 0x80],
          [0xf1, 0x80, 0x20, 0x80],
          [0xf1, 0x80, 0x80]
        ]

        const entries: Array<FixtureEntry> = invalid.map((bytes, index) => ({
          kind: "file",
          path: `/bad${index}`,
          bytes: new Uint8Array([...encoder.encode("hit\n"), ...bytes])
        }))

        entries.push(file("/valid", "hit\u0080\u07ff\u0800\ud7ff\ue000\uffff\u{10000}\u{10ffff}"))
        const snapshot = yield* snapshotOf(entries)

        for (
          const report of [
            yield* Search.lines(snapshot, query),
            yield* Search.files(snapshot, query),
            yield* Search.countLines(snapshot, query)
          ]
        ) {
          assert.strictEqual(report.skips.invalidUtf8Files, invalid.length)
          assert.strictEqual(report.skips.binaryFiles, 0)
          assert.strictEqual(report.results.length, 1)
          assert.strictEqual(report.completion._tag, "Complete")
        }

        assert.deepStrictEqual(yield* Stream.runCollect(Search.scanFiles(snapshot, query)), ["valid"])
      }))

    it.effect("reports file byte ranges while preserving BOM, Unicode and lone CR", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([file("/f", "\uFEFF😀hit\r\n\réhit\nhit\n")])
        const report = yield* Search.lines(snapshot, query)
        assert.deepStrictEqual(report.results, [
          rows("f", 1, 7, 10, "hit", true),
          rows("f", 2, 15, 18, "hit", true),
          rows("f", 3, 19, 22, "hit")
        ])
        const bom = yield* Search.lines(snapshot, { ...query, pattern: literal("\uFEFF") })
        assert.deepStrictEqual(bom.results, [rows("f", 1, 0, 3, "\uFEFF😀hit")])
        const cr = yield* Search.lines(snapshot, { ...query, pattern: regex("\\r") })
        assert.deepStrictEqual(cr.results, [rows("f", 2, 12, 13, "\réhit")])
      }))

    it.effect("keeps zero-width lines without inventing a final line or an empty-file line", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([file("/a", "\n😀\n"), file("/empty", "")])
        const report = yield* Search.lines(snapshot, { ...query, pattern: regex("$") })
        assert.deepStrictEqual(report.results, [rows("a", 1, 0, 0, ""), rows("a", 2, 5, 5, "", true)])
        assert.deepStrictEqual((yield* Search.countLines(snapshot, { ...query, pattern: regex("") })).results, [
          { path: "a", count: 2 }
        ])
      }))

    it.effect("bounds excerpts on scalar boundaries while preserving a longer full match", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([file("/f", "x😀😀tail")])
        const base = { ...query, pattern: literal("😀😀"), limits: { maxExcerptBytes: ByteSize.bytes(5) } }
        assert.deepStrictEqual((yield* Search.lines(snapshot, base)).results, [rows("f", 1, 1, 9, "😀", true)])
        assert.deepStrictEqual(
          (yield* Search.lines(snapshot, {
            ...base,
            limits: { maxExcerptBytes: ByteSize.bytes(3) }
          })).results,
          [rows("f", 1, 1, 9, "", true)]
        )
      }))

    it.effect("treats literal metacharacters literally and uses simple folding without normalization", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([file("/a", "a.b\naXb\nK\nk\né\né\nß\nss")])
        assert.deepStrictEqual((yield* Search.lines(snapshot, { ...query, pattern: literal("a.b") })).results, [
          rows("a", 1, 0, 3, "a.b")
        ])
        assert.deepStrictEqual(
          (yield* Search.lines(snapshot, { ...query, pattern: literal("k"), ignoreCase: true })).results.map((r) =>
            r.lineNumber
          ),
          [3, 4]
        )
        assert.deepStrictEqual(
          (yield* Search.lines(snapshot, { ...query, pattern: literal("é"), ignoreCase: true })).results.map((r) =>
            r.lineNumber
          ),
          [5]
        )
        assert.deepStrictEqual(
          (yield* Search.lines(snapshot, { ...query, pattern: literal("ss"), ignoreCase: true })).results.map((r) =>
            r.lineNumber
          ),
          [8]
        )
        assert.deepStrictEqual(
          (yield* Search.files(snapshot, { ...query, include: ["A"], pattern: literal("k"), ignoreCase: true }))
            .results,
          []
        )
      }))

    it.effect("scans each eligible hard-link name, prunes exclusions and follows only the selected root link", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([
          { kind: "directory", path: "/real" },
          file("/real/a", "hit"),
          { kind: "hardLink", path: "/real/b", target: "/real/a" },
          { kind: "symlink", path: "/real/c", target: "/real/a" },
          { kind: "directory", path: "/real/drop" },
          file("/real/drop/f", "hit"),
          { kind: "symlink", path: "/alias", target: "/real" }
        ])

        const selected = { ...query, root: "/alias", exclude: ["a", "drop/"] }
        const report = yield* Search.files(snapshot, selected)
        assert.deepStrictEqual(report.results, ["b"])
        assert.strictEqual(report.root, "/alias")
        assert.strictEqual(report.work.scannedBytes, ByteSize.bytes(3))
        assert.deepStrictEqual((yield* Search.countLines(snapshot, { ...selected, exclude: ["drop/"] })).results, [
          { path: "a", count: 1 },
          { path: "b", count: 1 }
        ])
      }))

    it.effect("skips oversized files without charging them and charges whole eligible files before matching", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([file("/a", "hit\nmiss"), file("/b", "hit")])

        const skipped = yield* Search.files(snapshot, {
          ...query,
          limits: { maxFileBytes: ByteSize.bytes(3), maxScannedBytes: ByteSize.bytes(3) }
        })

        assert.deepStrictEqual(skipped.results, ["b"])
        assert.strictEqual(skipped.skips.oversizedFiles, 1)
        assert.strictEqual(skipped.work.scannedBytes, ByteSize.bytes(3))
        const stopped = yield* Search.files(snapshot, { ...query, limits: { maxScannedBytes: ByteSize.bytes(7) } })
        assert.deepStrictEqual(stopped.results, [])
        assert.strictEqual(stopped.work.scannedBytes, ByteSize.bytes(0))
        assert.deepStrictEqual(stopped.completion, { _tag: "Stopped", limit: "maxScannedBytes", path: "a" })
        const fit = yield* Search.files(snapshot, { ...query, limits: { maxScannedBytes: ByteSize.bytes(8) } })
        assert.deepStrictEqual(fit.results, ["a"])
        assert.strictEqual(fit.work.scannedBytes, ByteSize.bytes(8))
        assert.strictEqual(fit.work.lineEvaluations, 1)
      }))

    it.effect("preflights exact payload sizes and retains earlier rows on a stop", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([file("/a", "hit"), file("/😀", "hit")])
        const line = yield* Search.lines(snapshot, { ...query, limits: { maxResultBytes: ByteSize.bytes(20) } })
        assert.deepStrictEqual(line.results, [rows("a", 1, 0, 3, "hit")])
        assert.strictEqual(line.work.resultBytes, ByteSize.bytes(20))
        assert.deepStrictEqual(line.completion, { _tag: "Stopped", limit: "maxResultBytes", path: "😀" })
        assert.strictEqual(
          (yield* Search.lines(snapshot, { ...query, limits: { maxResultBytes: ByteSize.bytes(43) } })).completion._tag,
          "Complete"
        )
        const count = yield* Search.countLines(snapshot, { ...query, limits: { maxResultBytes: ByteSize.bytes(9) } })
        assert.deepStrictEqual(count.results, [{ path: "a", count: 1 }])
        assert.strictEqual(count.work.resultBytes, ByteSize.bytes(9))
        assert.strictEqual(
          (yield* Search.countLines(snapshot, { ...query, limits: { maxResultBytes: ByteSize.bytes(21) } })).completion
            ._tag,
          "Complete"
        )
        assert.strictEqual(
          (yield* Search.files(snapshot, { ...query, limits: { maxResultBytes: ByteSize.bytes(5) } })).completion._tag,
          "Complete"
        )
      }))

    it.effect("discards an incomplete file count while preserving preceding completed files", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([file("/a", "hit"), file("/b", "hit\nhit")])
        const bounded = { ...query, limits: { maxLineEvaluations: 2 } }
        const counts = yield* Search.countLines(snapshot, bounded)
        assert.deepStrictEqual(counts.results, [{ path: "a", count: 1 }])
        assert.strictEqual(counts.work.lineEvaluations, 2)
        assert.deepStrictEqual(counts.completion, { _tag: "Stopped", limit: "maxLineEvaluations", path: "b" })
        assert.deepStrictEqual((yield* Search.lines(snapshot, bounded)).results.map((r) => r.path), ["a", "b"])
        assert.deepStrictEqual((yield* Search.files(snapshot, bounded)).results, ["a", "b"])
        const emitted: Array<Search.CountResult> = []

        const error = yield* Effect.flip(
          Stream.runForEach(Search.scanCountLines(snapshot, bounded), (row) =>
            Effect.sync(() => {
              emitted.push(row)
            }))
        )

        assert.deepStrictEqual(emitted, counts.results)
        assert.instanceOf(error, Search.BudgetExceeded)
      }))

    it.effect("stops immediately at result caps and Streams emit the same prefix before typed failure", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([file("/a", "hit")])
        const bounded = { ...query, limits: { maxResults: 1 } }

        for (
          const report of [
            yield* Search.lines(snapshot, bounded),
            yield* Search.files(snapshot, bounded),
            yield* Search.countLines(snapshot, bounded)
          ]
        ) {
          assert.deepStrictEqual(report.completion, { _tag: "Stopped", limit: "maxResults", path: "a" })
        }

        const streams: ReadonlyArray<Stream.Stream<unknown, Search.ScanContentFailure>> = [
          Search.scanLines(snapshot, bounded),
          Search.scanFiles(snapshot, bounded),
          Search.scanCountLines(snapshot, bounded)
        ]

        for (const stream of streams) {
          const emitted: Array<unknown> = []

          const error = yield* Effect.flip(
            Stream.runForEach(
              stream,
              (row) =>
                Effect.sync(() => {
                  emitted.push(row)
                })
            )
          )

          assert.strictEqual(emitted.length, 1)
          assert.instanceOf(error, Search.BudgetExceeded)
        }

        const zero = yield* Search.lines(snapshot, { ...query, limits: { maxResults: 0 } })
        assert.strictEqual(zero.work.entries, 0)
        assert.deepStrictEqual(zero.results, [])
      }))

    it.effect("validates literal policy, native syntax and limits before root lookup", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([])

        for (const pattern of ["", "\0", "\r", "\n", "\uD800"]) {
          // SAFETY: Deliberately bypass the constructor to prove query-boundary validation rejects malformed literals.
          const malformed = {
            ...query,
            root: "/missing",
            pattern: { _tag: "Literal", pattern }
          } as Search.ContentQuery

          assert.instanceOf(yield* Effect.flip(Search.lines(snapshot, malformed)), Search.QueryFailure)
        }

        assert.instanceOf(
          yield* Effect.flip(Search.files(snapshot, { ...query, root: "/missing", pattern: regex("[") })),
          Search.QueryFailure
        )
        assert.instanceOf(
          yield* Effect.flip(Search.lines(snapshot, { ...query, limits: { maxLineEvaluations: -1 } })),
          Search.QueryFailure
        )
        assert.instanceOf(
          yield* Effect.flip(Search.lines(snapshot, { ...query, limits: { maxPatternBytes: ByteSize.bytes(2) } })),
          Search.QueryFailure
        )

        const missing = yield* Effect.flip(
          Search.lines(snapshot, { ...query, root: "/missing", limits: { maxResults: 0 } })
        )

        assert.isTrue("code" in missing && missing.code === "NotFound")
      }))

    it.effect("starts repeated and concurrent collectors and Streams with fresh state", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([file("/a", "hit\nhit")])
        const effect = Search.lines(snapshot, { ...query, limits: { maxResults: 1 } })
        const first = yield* effect
        assert.deepStrictEqual(yield* effect, first)
        assert.deepStrictEqual(yield* Effect.all([effect, effect], { concurrency: "unbounded" }), [first, first])
        const stream = Search.scanCountLines(snapshot, query)
        assert.deepStrictEqual(
          yield* Effect.all([Stream.runCollect(stream), Stream.runCollect(stream)], { concurrency: "unbounded" }),
          [
            [{ path: "a", count: 2 }],
            [{ path: "a", count: 2 }]
          ]
        )
      }))

    it.effect("searches captured content after live edits and merged overlay snapshots", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.fromFixture({ entries: [file("/f", "hit")] })
        const captured = yield* volume.snapshot
        const caller = yield* volume.caller()
        yield* caller.writeFile("/f", encoder.encode("miss"), { access: "write" })
        assert.deepStrictEqual((yield* Search.files(captured, query)).results, ["f"])
        assert.deepStrictEqual((yield* Search.files(yield* volume.snapshot, query)).results, [])
        const overlay = yield* Vfs.makeOverlay(captured)
        const workspace = yield* overlay.caller()
        yield* workspace.unlink("/f")
        yield* workspace.writeFile("/new", encoder.encode("hit"), { access: "write", create: "exclusive" })
        assert.deepStrictEqual((yield* Search.files(yield* overlay.snapshot, query)).results, ["new"])
        assert.deepStrictEqual((yield* Search.files(captured, query)).results, ["f"])
      }))

    it.effect("yields inside classification before exhausting a large selected file", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([file("/f", "x".repeat(100_000))])
        const state = yield* Image.valueOf(snapshot)
        const root = getNode(state, ROOT_INO)!

        if (root.kind !== "directory") return assert.fail("Expected directory root")
        const ino = root.entries.values().next().value!
        const node = getNode(state, ino)!

        if (node.kind !== "file") return assert.fail("Expected regular file")
        let reads = 0

        const data = new Proxy(node.data, {
          get(target, property) {
            if (property === "length") return target.length

            if (property === "subarray") return target.subarray.bind(target)

            if (Predicate.isString(property) && /^\d+$/u.test(property)) reads++

            return Object.getOwnPropertyDescriptor(target, property)?.value
          }
        })

        const guarded = Image.make({ ...state, inodes: InodeTable.set(state.inodes, ino, { ...node, data }) })
        const scanning = yield* Search.files(guarded, query).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Fiber.interrupt(scanning)
        assert.isTrue(Exit.isFailure(yield* Fiber.await(scanning)))
        assert.isTrue(reads > 0)
        assert.isTrue(reads < 100_000)
        assert.deepStrictEqual((yield* Search.files(snapshot, query)).results, [])
      }))

    it.effect("borrows immutable payload views and files/count modes never construct excerpt views", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([file("/f", "prefix hit suffix")])
        const state = yield* Image.valueOf(snapshot)
        const root = getNode(state, ROOT_INO)!

        if (root.kind !== "directory") return assert.fail("Expected directory root")
        const ino = root.entries.values().next().value!
        const node = getNode(state, ino)!

        if (node.kind !== "file") return assert.fail("Expected regular file")
        const views: Array<readonly [number | undefined, number | undefined]> = []

        const data = new Proxy(node.data, {
          get(target, property) {
            if (property === "slice") {
              return () => {
                throw new Error("Search copied file bytes")
              }
            }

            if (property === "subarray") {
              return (start?: number, end?: number) => {
                views.push([start, end])

                return target.subarray(start, end)
              }
            }

            if (property === "length") return target.length

            return Object.getOwnPropertyDescriptor(target, property)?.value
          }
        })

        const guarded = Image.make({ ...state, inodes: InodeTable.set(state.inodes, ino, { ...node, data }) })
        assert.deepStrictEqual((yield* Search.files(guarded, query)).results, ["f"])
        assert.deepStrictEqual(views, [[0, 17]])
        views.length = 0
        assert.deepStrictEqual((yield* Search.countLines(guarded, query)).results, [{ path: "f", count: 1 }])
        assert.deepStrictEqual(views, [[0, 17]])
        views.length = 0
        const stopped = yield* Search.lines(guarded, { ...query, limits: { maxResultBytes: ByteSize.bytes(0) } })
        assert.deepStrictEqual(stopped.results, [])
        assert.deepStrictEqual(views, [[0, 17]])
      }))

    it.effect("leaves metadata, revisions, watches and durable commits unchanged for every mode", () => {
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
        yield* caller.writeFile("/f", encoder.encode("hit"), { access: "write", create: "exclusive" })
        const snapshot = yield* volume.snapshot
        const before = yield* caller.stat("/f")
        const rootBefore = yield* caller.stat("/")
        const committed = commits
        const changes = yield* Testing.collectChanges(yield* volume.watch(), 1)
        yield* Search.lines(snapshot, query)
        yield* Search.files(snapshot, { ...query, limits: { maxResults: 0 } })
        yield* Search.countLines(snapshot, query)
        yield* Stream.runCollect(Search.scanFiles(snapshot, query))
        yield* Stream.runCollect(Search.scanCountLines(snapshot, query))
        yield* Effect.flip(Search.lines(snapshot, { ...query, pattern: regex("[") }))
        const delivered = yield* Deferred.make<void>()

        const scanning = yield* Stream.runForEach(
          Search.scanLines(snapshot, query),
          () => Deferred.succeed(delivered, undefined).pipe(Effect.andThen(Effect.never))
        ).pipe(Effect.forkChild({ startImmediately: true }))

        yield* Deferred.await(delivered)
        yield* Fiber.interrupt(scanning)
        assert.isTrue(Exit.isFailure(yield* Fiber.await(scanning)))
        assert.deepStrictEqual(yield* caller.stat("/f"), before)
        assert.deepStrictEqual(yield* caller.stat("/"), rootBefore)
        assert.strictEqual(commits, committed)
        yield* caller.mkdir("/sentinel")
        const events = yield* changes
        assert.strictEqual(events.length, 1)
        assert.deepStrictEqual(yield* Vfs.pathToBytes(events[0]!.path), encoder.encode("/sentinel"))
      }).pipe(Effect.provide(store))
    })
  })
})

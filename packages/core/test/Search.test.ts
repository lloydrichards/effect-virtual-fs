import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Deferred, Effect, Exit, Fiber, Layer, pipe, Predicate, Schema, Stream } from "effect"
import type { FixtureEntry } from "../src/Fixture.js"
import { LiveVolume, Testing, VirtualFileSystem as Vfs } from "../src/index.js"
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

    it.effect("matches nested alternatives and charges combined include and exclude expansions", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([file("/a"), file("/b"), file("/c"), file("/z")])
        const query = { ...all, include: ["{a,{b,c}}"], exclude: ["z"] } as const
        const report = yield* Search.glob(snapshot, { ...query, limits: { maxExpansions: 4 } })
        assert.deepStrictEqual(report.results, ["a", "b", "c"])
        const failure = yield* Effect.flip(Search.glob(snapshot, { ...query, limits: { maxExpansions: 3 } }))
        assert.instanceOf(failure, Search.QueryFailure)

        if (Schema.is(Search.QueryFailure)(failure)) assert.strictEqual(failure.limit, "maxExpansions")
      }))

    it.effect("treats numeric brace ranges and extglob syntax as literal filenames", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([file("/{1..3}"), file("/@(a)"), file("/a"), file("/2")])
        const report = yield* Search.glob(snapshot, { ...all, include: ["{1..3}", "@(a)"] })
        assert.deepStrictEqual(report.results, ["@(a)", "{1..3}"])
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
          const [limit, limits] of [
            ["maxPatterns", { maxPatterns: 0 }],
            ["maxPatternBytes", { maxPatternBytes: ByteSize.bytes(0) }],
            ["maxPatternListBytes", { maxPatternListBytes: ByteSize.bytes(0) }],
            ["maxExpansions", { maxExpansions: 0 }],
            ["maxTokens", { maxTokens: 0 }]
          ] as const
        ) {
          const error = yield* Effect.flip(Search.glob(snapshot, { root: "/missing", include: ["a"], limits }))
          assert(Schema.is(Search.QueryFailure)(error))
          assert.strictEqual(error.limit, limit)
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

    it.effect("reports zero visits when the root exceeds the entry budget", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([file("/a"), file("/b")])
        const report = yield* Search.glob(snapshot, { ...all, limits: { maxEntries: 1 } })
        assert.deepStrictEqual(report.results, [])
        assert.strictEqual(report.work.entries, 0)
        assert.deepStrictEqual(report.completion, { _tag: "Stopped", limit: "maxEntries", path: "" })
      }))

    it.effect("yields during unmatched traversal so an evaluation can be interrupted before exhaustion", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf(Array.from({ length: 1024 }, (_, index) => file(`/f${index}`)))

        const scanning = yield* Search.glob(snapshot, { ...all, include: ["never"] }).pipe(
          Effect.forkChild({ startImmediately: true })
        )

        yield* Fiber.interrupt(scanning)
        assert.isTrue(Exit.isFailure(yield* Fiber.await(scanning)))
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

    it.effect("finds filenames regardless of content validity or byte budgets", () =>
      Effect.gen(function*() {
        const snapshot = yield* snapshotOf([
          { kind: "file", path: "/invalid", bytes: Uint8Array.of(255) },
          { kind: "file", path: "/binary", bytes: Uint8Array.of(0) }
        ])

        const report = yield* Search.glob(snapshot, {
          ...all,
          limits: { maxFileBytes: ByteSize.bytes(0), maxScannedBytes: ByteSize.bytes(0) }
        })

        assert.deepStrictEqual(report.results, ["binary", "invalid"])
        assert.strictEqual(report.work.scannedBytes, ByteSize.bytes(0))
        assert.strictEqual(report.skips.oversizedFiles, 0)
        assert.strictEqual(report.skips.invalidUtf8Files, 0)
        assert.strictEqual(report.skips.binaryFiles, 0)
        assert.deepStrictEqual(yield* Stream.runCollect(Search.scanGlob(snapshot, all)), ["binary", "invalid"])
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

describe("content search", () => {
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
      it.effect("should classify whole files when any search mode exposes matching prefixes", () =>
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

      it.effect("resumes whole-file classification across scalar boundaries before exposing matches", () =>
        Effect.gen(function*() {
          // The emoji starts at byte 4095 and crosses the classifier's first checkpoint.
          const text = "hit\n" + "x".repeat(4091) + "😀\nhit"
          const bytes = encoder.encode(text)

          const snapshot = yield* snapshotOf([
            { kind: "file", path: "/valid", bytes },
            { kind: "file", path: "/binary", bytes: new Uint8Array([...bytes, 0]) },
            { kind: "file", path: "/invalid", bytes: new Uint8Array([...bytes, 255]) }
          ])

          const lines = yield* Search.lines(snapshot, query)
          const files = yield* Search.files(snapshot, query)
          const counts = yield* Search.countLines(snapshot, query)

          assert.deepStrictEqual(lines.results, [rows("valid", 1, 0, 3, "hit"), rows("valid", 3, 4100, 4103, "hit")])
          assert.deepStrictEqual(files.results, ["valid"])
          assert.deepStrictEqual(counts.results, [{ path: "valid", count: 2 }])

          for (const report of [lines, files, counts]) {
            assert.strictEqual(report.skips.binaryFiles, 1)
            assert.strictEqual(report.skips.invalidUtf8Files, 1)
            assert.strictEqual(report.work.scannedBytes, ByteSize.bytes(bytes.length * 3 + 2))
            assert.strictEqual(report.completion._tag, "Complete")
          }

          assert.deepStrictEqual(yield* Stream.runCollect(Search.scanLines(snapshot, query)), lines.results)
          assert.deepStrictEqual(yield* Stream.runCollect(Search.scanFiles(snapshot, query)), files.results)
          assert.deepStrictEqual(yield* Stream.runCollect(Search.scanCountLines(snapshot, query)), counts.results)
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
            (yield* Search.lines(snapshot, { ...query, limits: { maxResultBytes: ByteSize.bytes(43) } })).completion
              ._tag,
            "Complete"
          )
          const count = yield* Search.countLines(snapshot, { ...query, limits: { maxResultBytes: ByteSize.bytes(9) } })
          assert.deepStrictEqual(count.results, [{ path: "a", count: 1 }])
          assert.strictEqual(count.work.resultBytes, ByteSize.bytes(9))
          assert.strictEqual(
            (yield* Search.countLines(snapshot, { ...query, limits: { maxResultBytes: ByteSize.bytes(21) } }))
              .completion
              ._tag,
            "Complete"
          )
          assert.strictEqual(
            (yield* Search.files(snapshot, { ...query, limits: { maxResultBytes: ByteSize.bytes(5) } })).completion
              ._tag,
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

          const exactFit = yield* Search.lines(snapshot, { ...query, limits: { maxPatternBytes: ByteSize.bytes(3) } })
          assert.deepStrictEqual(exactFit.results, [])

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
          const scanning = yield* Search.files(snapshot, query).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Fiber.interrupt(scanning)
          assert.isTrue(Exit.isFailure(yield* Fiber.await(scanning)))
          assert.deepStrictEqual((yield* Search.files(snapshot, query)).results, [])
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
})

describe("call styles", () => {
  const fixture: Vfs.Fixture = {
    entries: [{ kind: "file", path: "/message.txt", bytes: new TextEncoder().encode("hit\nmiss\nhit\n") }]
  }

  const globQuery: Search.GlobQuery = { root: "/", include: ["**/*.txt"] }

  const contentQuery: Search.ContentQuery = {
    ...globQuery,
    pattern: Search.Pattern.cases.Literal.make({ pattern: "hit" })
  }

  describe("data-first and data-last calls", () => {
    it.layer(BunCrypto.layer)((it) => {
      it.effect("finds snapshot names in both call styles", () =>
        Effect.gen(function*() {
          const snapshot = yield* (yield* Vfs.fromFixture(fixture)).snapshot
          const glob = yield* pipe(snapshot, Search.glob(globQuery))
          assert.deepStrictEqual(glob.results, ["message.txt"])
          assert.deepStrictEqual(glob, yield* Search.glob(snapshot, globQuery))
          assert.deepStrictEqual(yield* Stream.runCollect(pipe(snapshot, Search.scanGlob(globQuery))), glob.results)
          assert.deepStrictEqual(yield* Stream.runCollect(Search.scanGlob(snapshot, globQuery)), glob.results)
        }))

      it.effect("returns lines from snapshot content in both call styles", () =>
        Effect.gen(function*() {
          const snapshot = yield* (yield* Vfs.fromFixture(fixture)).snapshot
          const report = yield* pipe(snapshot, Search.lines(contentQuery))
          const { results } = report
          assert.deepStrictEqual(results.map((line) => line.lineNumber), [1, 3])
          assert.deepStrictEqual(report, yield* Search.lines(snapshot, contentQuery))
          assert.deepStrictEqual(yield* Stream.runCollect(pipe(snapshot, Search.scanLines(contentQuery))), results)
          assert.deepStrictEqual(yield* Stream.runCollect(Search.scanLines(snapshot, contentQuery)), results)
        }))

      it.effect("returns matching files from snapshot content in both call styles", () =>
        Effect.gen(function*() {
          const snapshot = yield* (yield* Vfs.fromFixture(fixture)).snapshot
          const report = yield* pipe(snapshot, Search.files(contentQuery))
          const { results } = report
          assert.deepStrictEqual(results, ["message.txt"])
          assert.deepStrictEqual(report, yield* Search.files(snapshot, contentQuery))
          assert.deepStrictEqual(yield* Stream.runCollect(pipe(snapshot, Search.scanFiles(contentQuery))), results)
          assert.deepStrictEqual(yield* Stream.runCollect(Search.scanFiles(snapshot, contentQuery)), results)
        }))

      it.effect("returns line counts from snapshot content in both call styles", () =>
        Effect.gen(function*() {
          const snapshot = yield* (yield* Vfs.fromFixture(fixture)).snapshot
          const report = yield* pipe(snapshot, Search.countLines(contentQuery))
          const { results } = report
          assert.deepStrictEqual(results, [{ path: "message.txt", count: 2 }])
          assert.deepStrictEqual(report, yield* Search.countLines(snapshot, contentQuery))
          assert.deepStrictEqual(yield* Stream.runCollect(pipe(snapshot, Search.scanCountLines(contentQuery))), results)
          assert.deepStrictEqual(yield* Stream.runCollect(Search.scanCountLines(snapshot, contentQuery)), results)
        }))

      it.effect("preserves typed query failures through curried calls", () =>
        Effect.gen(function*() {
          const snapshot = yield* (yield* Vfs.fromFixture(fixture)).snapshot
          const invalid = { ...globQuery, root: "/missing" }
          assert.deepStrictEqual(
            yield* Effect.flip(Search.glob(invalid)(snapshot)),
            yield* Effect.flip(Search.glob(snapshot, invalid))
          )
        }))
    })
  })
})

import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect, pipe, Stream } from "effect"
import { BytePath, Search, Testing, VirtualFileSystem as Vfs } from "../src/index.js"

const limits: Vfs.DecodeLimits = {
  maxEncodedBytes: ByteSize.kibibytes(16),
  maxRecords: 10,
  maxEntries: 10,
  maxDecodedBytes: ByteSize.kibibytes(16)
}

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
    it.effect("searches snapshots through reusable queries in both call styles", () =>
      Effect.gen(function*() {
        const snapshot = yield* (yield* Vfs.fromFixture(fixture)).snapshot
        const glob = yield* pipe(snapshot, Search.glob(globQuery))
        assert.deepStrictEqual(glob.results, ["message.txt"])
        assert.deepStrictEqual(glob, yield* Search.glob(snapshot, globQuery))
        assert.deepStrictEqual(yield* Stream.runCollect(pipe(snapshot, Search.scanGlob(globQuery))), glob.results)
        assert.deepStrictEqual(yield* Stream.runCollect(Search.scanGlob(snapshot, globQuery)), glob.results)

        const lines = yield* pipe(snapshot, Search.lines(contentQuery))
        const files = yield* pipe(snapshot, Search.files(contentQuery))
        const counts = yield* pipe(snapshot, Search.countLines(contentQuery))
        assert.deepStrictEqual(lines.results.map((line) => line.lineNumber), [1, 3])
        assert.deepStrictEqual(files.results, ["message.txt"])
        assert.deepStrictEqual(counts.results, [{ path: "message.txt", count: 2 }])
        assert.deepStrictEqual(lines, yield* Search.lines(snapshot, contentQuery))
        assert.deepStrictEqual(files, yield* Search.files(snapshot, contentQuery))
        assert.deepStrictEqual(counts, yield* Search.countLines(snapshot, contentQuery))
        assert.deepStrictEqual(yield* Stream.runCollect(pipe(snapshot, Search.scanLines(contentQuery))), lines.results)
        assert.deepStrictEqual(yield* Stream.runCollect(pipe(snapshot, Search.scanFiles(contentQuery))), files.results)
        assert.deepStrictEqual(
          yield* Stream.runCollect(pipe(snapshot, Search.scanCountLines(contentQuery))),
          counts.results
        )
        assert.deepStrictEqual(yield* Stream.runCollect(Search.scanLines(snapshot, contentQuery)), lines.results)
        assert.deepStrictEqual(yield* Stream.runCollect(Search.scanFiles(snapshot, contentQuery)), files.results)
        assert.deepStrictEqual(yield* Stream.runCollect(Search.scanCountLines(snapshot, contentQuery)), counts.results)
      }))

    it.effect("encodes with omitted, undefined, or explicit limits and decodes in either call style", () =>
      Effect.gen(function*() {
        const snapshot = yield* (yield* Vfs.fromFixture(fixture)).snapshot
        const expected = yield* Vfs.encodeSnapshot(snapshot)

        for (const encode of [Vfs.encodeSnapshot(), Vfs.encodeSnapshot(undefined), Vfs.encodeSnapshot(limits)]) {
          assert.deepStrictEqual(yield* encode(snapshot), expected)
        }

        assert.deepStrictEqual(yield* Vfs.encodeSnapshot(snapshot, undefined), expected)
        assert.deepStrictEqual(yield* Vfs.encodeSnapshot(snapshot, limits), expected)

        for (
          const encode of [
            Vfs.encodeSnapshotStream(),
            Vfs.encodeSnapshotStream(undefined),
            Vfs.encodeSnapshotStream(limits)
          ]
        ) {
          assert.deepStrictEqual(
            yield* Stream.runCollect(encode(snapshot)),
            yield* Stream.runCollect(Vfs.encodeSnapshotStream(snapshot))
          )
        }

        assert.deepStrictEqual(
          yield* Stream.runCollect(Vfs.encodeSnapshotStream(snapshot, limits)),
          yield* Stream.runCollect(Vfs.encodeSnapshotStream(snapshot, undefined))
        )
        const restored = yield* pipe(expected, Vfs.decodeSnapshot(limits))
        assert.deepStrictEqual(yield* Vfs.encodeSnapshot(restored), expected)
        assert.deepStrictEqual(yield* Vfs.encodeSnapshot(yield* Vfs.decodeSnapshot(expected, limits)), expected)
        const entries = yield* Stream.runCollect(pipe(restored, Vfs.snapshotEntries("/")))
        assert.deepStrictEqual(entries.map((entry) => entry.path), ["/", "/message.txt"])
        assert.deepStrictEqual(entries, yield* Stream.runCollect(Vfs.snapshotEntries(restored, "/")))
      }))

    it.effect("preserves typed query and codec failures through curried calls", () =>
      Effect.gen(function*() {
        const snapshot = yield* (yield* Vfs.fromFixture(fixture)).snapshot
        const invalid = { ...globQuery, root: "/missing" }
        assert.deepStrictEqual(
          yield* Effect.flip(Search.glob(invalid)(snapshot)),
          yield* Effect.flip(Search.glob(snapshot, invalid))
        )
        const bytes = yield* Vfs.encodeSnapshot(snapshot)
        const small = { ...limits, maxEncodedBytes: ByteSize.bytes(1) }
        assert.deepStrictEqual(
          yield* Effect.flip(Vfs.encodeSnapshot(small)(snapshot)),
          yield* Effect.flip(Vfs.encodeSnapshot(snapshot, small))
        )
        assert.deepStrictEqual(
          yield* Effect.flip(Vfs.decodeSnapshot(small)(bytes)),
          yield* Effect.flip(Vfs.decodeSnapshot(bytes, small))
        )
      }))
  })

  it.effect("joins byte paths in both call styles without losing raw names", () =>
    Effect.gen(function*() {
      const path = yield* BytePath.fromString("/work")
      const name = Uint8Array.of(255)
      assert.deepStrictEqual(
        yield* BytePath.toBytes(path.pipe(BytePath.join(name))),
        Uint8Array.of(47, 119, 111, 114, 107, 47, 255)
      )
      assert.deepStrictEqual(
        yield* BytePath.toBytes(BytePath.join(path, name)),
        yield* BytePath.toBytes(BytePath.join(name)(path))
      )
      assert.strictEqual(yield* BytePath.toString(path.pipe(BytePath.join("file"))), "/work/file")
    }))

  it.effect("collects the requested number of elements in both call styles", () =>
    Effect.gen(function*() {
      const stream = Stream.make(1, 2, 3)
      const direct = yield* Testing.collectChanges(stream, 2)
      const curried = yield* stream.pipe(Testing.collectChanges(2))
      assert.deepStrictEqual(yield* direct, [1, 2])
      assert.deepStrictEqual(yield* curried, [1, 2])
    }))
})

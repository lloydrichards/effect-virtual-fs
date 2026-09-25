import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Testing, VirtualFileSystem as Vfs } from "../src/index.js"
import { GUEST, write } from "./support/caller.js"
import { pathText, text } from "./support/text.js"

// /tree holds b/ (with deep/leaf), a (a file of 3 bytes), and c, a link to b that a walk must not follow.
const arrange = Effect.gen(function*() {
  const fs = yield* Vfs.Caller
  yield* fs.mkdir("/tree")
  yield* fs.mkdir("/tree/b")
  yield* fs.mkdir("/tree/b/deep")
  yield* write(fs, "/tree/b/deep/leaf")
  yield* write(fs, "/tree/a", 3)
  yield* fs.symlink("b", "/tree/c")

  return fs
})

// Each entry as its kind, path and depth.
const describeEntry = (entry: Vfs.WalkEntry) =>
  Effect.map(pathText(entry.path), (path) => `${entry.kind} ${path} ${entry.depth}`)

const collect = <E>(stream: Stream.Stream<Vfs.WalkEntry, E>) =>
  Effect.flatMap(Stream.runCollect(stream), (entries) => Effect.forEach(entries, describeEntry))

const failure = (error: Vfs.WalkFailure) =>
  Effect.map(pathText(error.path), (path) => [error.code, error.field, path] as const)

describe("walk", () => {
  it.effect("reports each directory before its entries, in the byte order of their names", () =>
    Effect.gen(function*() {
      const fs = yield* arrange

      assert.deepStrictEqual(yield* collect(fs.walk("/tree")), [
        "file a 1",
        "directory b 1",
        "directory b/deep 2",
        "file b/deep/leaf 3",
        "symlink c 1"
      ])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("reports each directory after its entries in a post-order walk", () =>
    Effect.gen(function*() {
      const fs = yield* arrange

      assert.deepStrictEqual(yield* collect(fs.walk("/tree", { order: "post" })), [
        "file a 1",
        "file b/deep/leaf 3",
        "directory b/deep 2",
        "directory b 1",
        "symlink c 1"
      ])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("orders names by their bytes, not their text", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      const root = yield* fs.root

      for (const name of [new Uint8Array([0xff]), new TextEncoder().encode("b"), new TextEncoder().encode("B")]) {
        yield* fs.mkdir(Vfs.Entry(root, name))
      }

      const names = yield* Stream.runCollect(Stream.map(fs.walk(root), (entry) => Array.from(entry.name)))

      assert.deepStrictEqual(names, [[0x42], [0x62], [0xff]])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("names each entry by a reference and the directory it was listed in", () =>
    Effect.gen(function*() {
      const fs = yield* arrange
      const entries = yield* Stream.runCollect(fs.walk("/tree"))
      const deep = entries.find((entry) => text(entry.name) === "deep")

      assert.isDefined(deep)
      assert.strictEqual(deep.reference, yield* fs.lookup("/tree/b/deep"))
      assert.strictEqual(deep.directory, yield* fs.lookup("/tree/b"))
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("walks from a reference with the same relative paths", () =>
    Effect.gen(function*() {
      const fs = yield* arrange

      assert.deepStrictEqual(
        yield* collect(fs.walk(yield* fs.lookup("/tree/b"))),
        ["directory deep 1", "file deep/leaf 2"]
      )
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("follows a final symbolic link at the root, as a path does, and no link below it", () =>
    Effect.gen(function*() {
      const fs = yield* arrange

      assert.deepStrictEqual(yield* collect(fs.walk("/tree/c")), ["directory deep 1", "file deep/leaf 2"])

      const error = yield* Effect.flip(
        Stream.runDrain(fs.walk(Vfs.Target.Path({ path: "/tree/c", followFinalSymlink: false })))
      )

      assert.deepStrictEqual(yield* failure(error), ["NotDirectory", undefined, "/tree/c"])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("fails once an entry lies deeper than maxDepth, naming it", () =>
    Effect.gen(function*() {
      const fs = yield* arrange
      const entries: Array<string> = []

      const error = yield* Effect.flip(
        Stream.runForEach(fs.walk("/tree", { maxDepth: 2 }), (entry) =>
          Effect.map(describeEntry(entry), (line) => {
            entries.push(line)
          }))
      )

      // The entries before the one that crossed the bound are all handed on.
      assert.deepStrictEqual(entries, ["file a 1", "directory b 1", "directory b/deep 2"])
      assert.deepStrictEqual(yield* failure(error), ["LimitExceeded", "maxDepth", "/tree/b/deep/leaf"])
      assert.strictEqual((yield* collect(fs.walk("/tree", { maxDepth: 3 }))).length, 5)
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("fails at the first entry past maxEntries or maxBytes", () =>
    Effect.gen(function*() {
      const fs = yield* arrange

      const entries = yield* Effect.flip(Stream.runDrain(fs.walk("/tree", { maxEntries: 2 })))
      assert.deepStrictEqual(yield* failure(entries), ["LimitExceeded", "maxEntries", "/tree/b/deep"])

      // The file holds three bytes, the leaf one: the leaf is the fourth byte.
      const bytes = yield* Effect.flip(Stream.runDrain(fs.walk("/tree", { maxBytes: ByteSize.bytes(3) })))
      assert.deepStrictEqual(yield* failure(bytes), ["LimitExceeded", "maxBytes", "/tree/b/deep/leaf"])

      // The link's one-byte target counts as well.
      assert.strictEqual((yield* collect(fs.walk("/tree", { maxEntries: 5, maxBytes: ByteSize.bytes(5) }))).length, 5)
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("reads no directory past maxDepth in a post-order walk", () =>
    Effect.gen(function*() {
      const fs = yield* arrange
      const seen: Array<string> = []

      const error = yield* Effect.flip(
        Stream.runForEach(fs.walk("/tree", { order: "post", maxDepth: 1 }), (entry) =>
          Effect.map(describeEntry(entry), (line) => {
            seen.push(line)
          }))
      )

      assert.deepStrictEqual(seen, ["file a 1"])
      assert.deepStrictEqual(yield* failure(error), ["LimitExceeded", "maxDepth", "/tree/b/deep"])

      // A directory past the bound that the caller may not read still fails on the bound, since it is never read.
      yield* fs.chmod("/tree/b/deep", 0o000)
      const guest = yield* Testing.callerAs(GUEST)
      const denied = yield* Effect.flip(Stream.runDrain(guest.walk("/tree", { order: "post", maxDepth: 1 })))
      assert.deepStrictEqual(yield* failure(denied), ["LimitExceeded", "maxDepth", "/tree/b/deep"])

      // Within the bound, the deepest directory is read and its entry is the first past it.
      const leaf = yield* Effect.flip(Stream.runDrain(fs.walk("/tree", { order: "post", maxDepth: 2 })))
      assert.deepStrictEqual(yield* failure(leaf), ["LimitExceeded", "maxDepth", "/tree/b/deep/leaf"])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("fails at the first entry past maxEntries or maxBytes in a post-order walk", () =>
    Effect.gen(function*() {
      const fs = yield* arrange

      const entries = yield* Effect.flip(Stream.runDrain(fs.walk("/tree", { order: "post", maxEntries: 2 })))
      assert.deepStrictEqual(yield* failure(entries), ["LimitExceeded", "maxEntries", "/tree/b/deep"])

      const bytes = yield* Effect.flip(
        Stream.runDrain(fs.walk("/tree", { order: "post", maxBytes: ByteSize.bytes(3) }))
      )

      assert.deepStrictEqual(yield* failure(bytes), ["LimitExceeded", "maxBytes", "/tree/b/deep/leaf"])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("rejects malformed options when it runs", () =>
    Effect.gen(function*() {
      const fs = yield* arrange
      // A negative bound type-checks; the schema rejects it.
      const error = yield* Effect.flip(Stream.runDrain(fs.walk("/tree", { maxDepth: -1 })))

      assert.deepStrictEqual(yield* failure(error), ["InvalidArgument", undefined, "/tree"])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("skips the entries of a directory that went away after it was listed", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      yield* fs.mkdir("/tree")
      yield* fs.mkdir("/tree/a")
      yield* write(fs, "/tree/a/x")
      yield* fs.mkdir("/tree/b")
      yield* write(fs, "/tree/b/y")
      const seen: Array<string> = []

      // Reading /tree/a ends the first pull, so /tree/b is removed before the walk reads it.
      yield* Stream.runForEach(fs.walk("/tree"), (entry) =>
        Effect.gen(function*() {
          seen.push(yield* describeEntry(entry))

          if (text(entry.name) === "a") {
            yield* fs.unlink("/tree/b/y")
            yield* fs.rmdir("/tree/b")
          }
        }))

      assert.deepStrictEqual(seen, ["directory a 1", "file a/x 2", "directory b 1"])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("does not follow a directory renamed out of the tree after it was listed", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      yield* fs.mkdir("/keep")
      yield* fs.mkdir("/work")
      yield* fs.mkdir("/work/a")
      yield* write(fs, "/work/a/x")
      yield* fs.mkdir("/work/z")
      yield* write(fs, "/work/z/k")
      const seen: Array<string> = []

      // Reading /work/a ends the first pull, so /work/z moves out before the walk reads it.
      yield* Stream.runForEach(fs.walk("/work"), (entry) =>
        Effect.gen(function*() {
          seen.push(yield* describeEntry(entry))

          if (text(entry.name) === "a") yield* fs.rename("/work/z", "/keep/z")
        }))

      assert.deepStrictEqual(seen, ["directory a 1", "file a/x 2", "directory z 1"])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("does not follow its root renamed away after it was listed", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      yield* fs.mkdir("/work")
      yield* fs.mkdir("/work/a")
      yield* write(fs, "/work/a/x")
      yield* fs.mkdir("/work/b")
      yield* write(fs, "/work/b/y")
      const seen: Array<string> = []

      // Reading /work/a ends the first pull, so /work moves away before the walk reads /work/b, which the walk
      // reaches through the name /work and so no longer reaches.
      yield* Stream.runForEach(fs.walk("/work"), (entry) =>
        Effect.gen(function*() {
          seen.push(yield* describeEntry(entry))

          if (text(entry.name) === "a") yield* fs.rename("/work", "/keep")
        }))

      assert.deepStrictEqual(seen, ["directory a 1", "file a/x 2", "directory b 1"])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("refuses to descend below a directory it may read but not search, as POSIX does", () =>
    Effect.gen(function*() {
      const fs = yield* arrange
      yield* fs.chmod("/tree/b", 0o444)
      const guest = yield* Testing.callerAs(GUEST)
      const seen: Array<string> = []

      const error = yield* Effect.flip(
        Stream.runForEach(guest.walk("/tree"), (entry) =>
          Effect.map(describeEntry(entry), (line) => {
            seen.push(line)
          }))
      )

      // Listing /tree/b names its entries; reaching /tree/b/deep needs search permission on /tree/b.
      assert.deepStrictEqual(seen, ["file a 1", "directory b 1", "directory b/deep 2"])
      assert.deepStrictEqual(yield* failure(error), ["AccessDenied", undefined, "/tree/b/deep"])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("fails on a directory it may not read, naming it under the root's path", () =>
    Effect.gen(function*() {
      const fs = yield* arrange
      yield* fs.chmod("/tree/b", 0o311)
      const guest = yield* Testing.callerAs(GUEST)
      const seen: Array<string> = []

      const error = yield* Effect.flip(
        Stream.runForEach(guest.walk("/tree"), (entry) =>
          Effect.map(describeEntry(entry), (line) => {
            seen.push(line)
          }))
      )

      assert.deepStrictEqual(seen, ["file a 1", "directory b 1"])
      assert.deepStrictEqual(yield* failure(error), ["AccessDenied", undefined, "/tree/b"])

      // A reference root names the path below it.
      const below = yield* Effect.flip(Stream.runDrain(guest.walk(yield* fs.lookup("/tree"))))
      assert.deepStrictEqual(yield* failure(below), ["AccessDenied", undefined, "b"])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("refreshes no access time", () =>
    Effect.gen(function*() {
      const fs = yield* arrange
      const before = yield* fs.stat("/tree/b")
      yield* TestClock.adjust("1 second")

      yield* Stream.runDrain(fs.walk("/tree"))
      assert.strictEqual((yield* fs.stat("/tree/b")).atimeNs, before.atimeNs)

      // A listing of the same directory would.
      yield* fs.readDirectory("/tree/b")
      assert.notStrictEqual((yield* fs.stat("/tree/b")).atimeNs, before.atimeNs)
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("reports nothing for an empty directory and fails on a missing root", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      yield* fs.mkdir("/empty")

      assert.deepStrictEqual(yield* collect(fs.walk("/empty")), [])
      assert.deepStrictEqual(
        yield* failure(yield* Effect.flip(Stream.runDrain(fs.walk("/missing")))),
        ["NotFound", undefined, "/missing"]
      )
    }).pipe(Effect.provide(Testing.layer())))
})

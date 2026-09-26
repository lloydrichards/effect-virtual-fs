import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Predicate, Stream } from "effect"
import { BytePath, VirtualFileSystem as Vfs } from "../src/index.js"

const encoder = new TextEncoder()

const entriesOf = (snapshot: Vfs.Snapshot, root: Vfs.PathInput) =>
  Stream.runCollect(Vfs.snapshotEntries(snapshot, root))

// What an entry says, with paths and targets as text or as their bytes in hex.
const described = Effect.fnUntraced(function*(entries: ReadonlyArray<Vfs.Fixture["entries"][number]>) {
  const show = (path: Vfs.PathInput) =>
    Predicate.isString(path)
      ? Effect.succeed(path)
      : Effect.map(BytePath.toBytes(path), (bytes) => `0x${[...bytes].map((byte) => byte.toString(16)).join("")}`)

  const rows: Array<string> = []

  for (const entry of entries) {
    const target = entry.kind === "hardLink" || entry.kind === "symlink" ? ` -> ${yield* show(entry.target)}` : ""
    rows.push(`${entry.kind} ${yield* show(entry.path)}${target}`)
  }

  return rows
})

const tree = Effect.gen(function*() {
  const raw = yield* Vfs.pathFromBytes(new Uint8Array([...encoder.encode("/src/raw-"), 0xff]))

  const volume = yield* Vfs.fromFixture({
    entries: [
      { kind: "directory", path: "/src" },
      { kind: "directory", path: "/src/b" },
      { kind: "file", path: "/src/b/data", bytes: new Uint8Array([1, 2]), metadata: { mode: 0o600, mtimeNs: 5n } },
      { kind: "file", path: "/src/a", bytes: new Uint8Array([3]) },
      { kind: "hardLink", path: "/src/z", target: "/src/a" },
      { kind: "symlink", path: "/src/up", target: "b/data" },
      { kind: "file", path: raw, bytes: new Uint8Array() },
      { kind: "symlink", path: "/via", target: "src/b" },
      { kind: "symlink", path: "/loop", target: "loop/x" },
      { kind: "symlink", path: "/long", target: "/src/b/./././././././././data" }
    ]
  })

  return yield* volume.snapshot
})

describe("snapshot entries", () => {
  it.effect("streams the tree under a root in sorted pre-order, rooted at the root", () =>
    Effect.gen(function*() {
      const entries = yield* entriesOf(yield* tree, "/src")

      assert.deepStrictEqual(yield* described(entries), [
        "directory /",
        "file /a",
        "directory /b",
        "file /b/data",
        "file 0x2f7261772dff",
        "symlink /up -> b/data",
        "hardLink /z -> /a"
      ])

      const data = entries[3]!
      assert.deepStrictEqual(data.kind === "file" && [data.bytes, data.metadata?.mode, data.metadata?.mtimeNs], [
        new Uint8Array([1, 2]),
        0o600,
        5n
      ])
    }))

  it.effect("hands out copies of file bytes and rebuilds the same tree from a fixture", () =>
    Effect.gen(function*() {
      const snapshot = yield* tree
      const entries = yield* entriesOf(snapshot, "/src")
      const [, first] = entries

      if (first?.kind === "file") first.bytes.fill(9)
      const again = yield* entriesOf(snapshot, "/src")
      assert.deepStrictEqual(again[1]?.kind === "file" && again[1].bytes, new Uint8Array([3]))

      // Every entry but the root's, which a fixture states through its root metadata.
      const [root, ...rest] = again
      const rootMetadata = root?.kind === "directory" ? root.metadata : undefined

      const rebuilt = yield* Vfs.fromFixture(
        rootMetadata === undefined ? { entries: rest } : { rootMetadata, entries: rest }
      )

      assert.deepStrictEqual(yield* described(yield* entriesOf(yield* rebuilt.snapshot, "/")), yield* described(again))
    }))

  it.effect("resolves the root through intermediate links but not a final one", () =>
    Effect.gen(function*() {
      const snapshot = yield* tree

      assert.deepStrictEqual(yield* described(yield* entriesOf(snapshot, "/via")), ["symlink / -> src/b"])
      assert.deepStrictEqual(yield* described(yield* entriesOf(snapshot, "/via/")), ["directory /", "file /data"])
      assert.deepStrictEqual(yield* described(yield* entriesOf(snapshot, "via/./data")), ["file /"])
      assert.deepStrictEqual(yield* described(yield* entriesOf(snapshot, "/src/b/../a")), ["file /"])
    }))

  it.effect("resolves a root, or fails to, as a caller of the restored volume stating it would", () =>
    Effect.gen(function*() {
      const snapshot = yield* tree
      const caller = yield* (yield* Vfs.fromSnapshot(snapshot)).caller()

      // What each side makes of a root: the kind it reaches, or the code it fails with.
      const outcome = <A>(effect: Effect.Effect<A, Vfs.VfsError>, kind: (value: A) => string) =>
        Effect.match(effect, { onFailure: (error) => error.code, onSuccess: kind })

      for (
        const root of [
          "/",
          "/src",
          "/via",
          "/via/",
          "via/./data",
          "/src/b/../a",
          "/via/../src",
          "/src/up",
          "/src/up/",
          "/long",
          "/long/",
          "/missing",
          "/src/a/",
          "/src/a/b",
          "/loop/",
          ""
        ]
      ) {
        const entries = yield* outcome(
          Stream.runHead(Vfs.snapshotEntries(snapshot, root)),
          Option.match({ onNone: () => "empty", onSome: (entry) => entry.kind })
        )

        const stated = yield* outcome(
          caller.stat(Vfs.Target.Path({ path: root, followFinalSymlink: false })),
          (metadata) => metadata.kind
        )

        assert.strictEqual(entries, stated, root)
      }

      const failed = yield* Effect.flip(Stream.runHead(Vfs.snapshotEntries(snapshot, "/missing")))
      assert.strictEqual(failed.operation, "snapshotEntries")
    }))
})

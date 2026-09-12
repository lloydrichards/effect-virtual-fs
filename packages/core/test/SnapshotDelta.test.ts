import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"

const encoder = new TextEncoder()
const snapshotLimits = { maxEncodedBytes: 1_000_000, maxRecords: 100, maxEntries: 100, maxDecodedBytes: 100_000 }
const snapshotFromDocument = (document: unknown) =>
  Vfs.decodeSnapshot(encoder.encode(JSON.stringify(document)), snapshotLimits)
const snapshotDocument = (snapshot: Vfs.Snapshot) =>
  Vfs.encodeSnapshot(snapshot).pipe(Effect.map((bytes) => JSON.parse(new TextDecoder().decode(bytes))))
const deltaLimitsWith = (
  field: "maxIdentityBytes" | "maxDecodedDeltaBytes" | "maxOutputBytes",
  value: number
): Vfs.SnapshotDeltaLimits => {
  const current = Vfs.SnapshotDeltaLimits.default[field]
  return Schema.decodeSync(Vfs.SnapshotDeltaLimits)({
    ...Vfs.SnapshotDeltaLimits.default,
    [field]: typeof current === "bigint" ? BigInt(value) : value
  })
}

describe("snapshot deltas", () => {
  it.effect("reconstructs node kinds, raw paths, payloads, and every retained metadata field", () =>
    Effect.gen(function*() {
      const raw = yield* Vfs.pathFromBytes(new Uint8Array([47, 255]))
      const base = yield* Vfs.fromFixture({
        rootMetadata: { mode: 0o700, uid: 1, gid: 2, atimeNs: 1n, mtimeNs: 2n, ctimeNs: 3n, birthtimeNs: 4n },
        entries: [
          { kind: "file", path: "/removed", bytes: new Uint8Array([1]) },
          { kind: "file", path: "/becomes-directory", bytes: new Uint8Array([2]) },
          { kind: "directory", path: "/becomes-file" },
          { kind: "symlink", path: "/link", target: "old-target" }
        ]
      })
      const target = yield* Vfs.fromFixture({
        rootMetadata: { mode: 0o755, uid: 5, gid: 6, atimeNs: 11n, mtimeNs: 12n, ctimeNs: 13n, birthtimeNs: 14n },
        entries: [
          { kind: "directory", path: "/becomes-directory", metadata: { mode: 0o750 } },
          {
            kind: "file",
            path: "/becomes-file",
            bytes: new Uint8Array([3, 4]),
            metadata: { mode: 0o640, uid: 7, gid: 8, atimeNs: 21n, mtimeNs: 22n, ctimeNs: 23n, birthtimeNs: 24n }
          },
          { kind: "file", path: raw, bytes: new Uint8Array([255, 0]) },
          { kind: "symlink", path: "/link", target: raw }
        ]
      })

      const baseSnapshot = yield* base.snapshot
      const delta = yield* Vfs.diffSnapshots(baseSnapshot, yield* target.snapshot)
      const fs = yield* (yield* Vfs.fromSnapshot(yield* Vfs.applySnapshotDelta(baseSnapshot, delta))).caller()

      const root = yield* fs.stat("/")
      assert.deepStrictEqual([
        root.mode,
        root.uid,
        root.gid,
        root.atimeNs,
        root.mtimeNs,
        root.ctimeNs,
        root.birthtimeNs
      ], [0o755, 5, 6, 11n, 12n, 13n, 14n])
      assert.deepStrictEqual(
        (yield* fs.readDirectoryBytes("/")).map((name) => Array.from(name).join(",")).sort(),
        [
          encoder.encode("becomes-directory"),
          encoder.encode("becomes-file"),
          encoder.encode("link"),
          new Uint8Array([255])
        ]
          .map((name) => Array.from(name).join(",")).sort()
      )
      const stat = yield* fs.stat("/becomes-file")
      assert.deepStrictEqual([
        stat.kind,
        stat.mode,
        stat.uid,
        stat.gid,
        stat.atimeNs,
        stat.mtimeNs,
        stat.ctimeNs,
        stat.birthtimeNs
      ], ["file", 0o640, 7, 8, 21n, 22n, 23n, 24n])
      assert.deepStrictEqual(yield* fs.readFile("/becomes-file"), new Uint8Array([3, 4]))
      assert.strictEqual((yield* fs.stat("/becomes-directory")).kind, "directory")
      assert.deepStrictEqual(yield* fs.readFile(raw), new Uint8Array([255, 0]))
      assert.deepStrictEqual(yield* fs.readLinkBytes("/link"), new Uint8Array([47, 255]))
      assert.strictEqual((yield* Effect.flip(fs.stat("/removed"))).code, "NotFound")
    }).pipe(Effect.provide(BunCrypto.layer)))

  it.effect("reports path evidence without rename inference and preserves hard-link split and join topology", () =>
    Effect.gen(function*() {
      const base = yield* Vfs.fromFixture({
        entries: [
          { kind: "file", path: "/old", bytes: new Uint8Array([1]) },
          { kind: "hardLink", path: "/old-alias", target: "/old" },
          { kind: "file", path: "/split-a", bytes: new Uint8Array([2]) },
          { kind: "hardLink", path: "/split-b", target: "/split-a" },
          { kind: "file", path: "/join-a", bytes: new Uint8Array([3]) },
          { kind: "file", path: "/join-b", bytes: new Uint8Array([3]) }
        ]
      })
      const target = yield* Vfs.fromFixture({
        entries: [
          { kind: "file", path: "/new", bytes: new Uint8Array([1]) },
          { kind: "hardLink", path: "/new-alias", target: "/new" },
          { kind: "file", path: "/split-a", bytes: new Uint8Array([2]) },
          { kind: "file", path: "/split-b", bytes: new Uint8Array([2]) },
          { kind: "file", path: "/join-a", bytes: new Uint8Array([3]) },
          { kind: "hardLink", path: "/join-b", target: "/join-a" }
        ]
      })
      const baseSnapshot = yield* base.snapshot
      const delta = yield* Vfs.diffSnapshots(baseSnapshot, yield* target.snapshot)
      const changes = yield* Vfs.inspectSnapshotDelta(baseSnapshot, delta)
      const names = yield* Effect.forEach(
        changes,
        (change) => Vfs.pathToBytes(change.path).pipe(Effect.map((bytes) => new TextDecoder().decode(bytes)))
      )

      assert.deepStrictEqual(names, [
        "/join-a",
        "/join-b",
        "/new",
        "/new-alias",
        "/old",
        "/old-alias",
        "/split-a",
        "/split-b"
      ])
      assert.isFalse(changes.some((change) => (change as { readonly _tag: string })._tag === "Renamed"))
      for (const path of ["/join-a", "/join-b", "/split-a", "/split-b"]) {
        const change = changes[names.indexOf(path)]
        assert.strictEqual(change?._tag, "Updated")
        if (change?._tag === "Updated") assert.include(change.differences, "hardLinks")
      }
      assert.deepStrictEqual(changes.slice(2, 6).map((change) => change._tag), ["Added", "Added", "Removed", "Removed"])

      const fs = yield* (yield* Vfs.fromSnapshot(yield* Vfs.applySnapshotDelta(baseSnapshot, delta))).caller()
      assert.notStrictEqual((yield* fs.stat("/split-a")).ino, (yield* fs.stat("/split-b")).ino)
      assert.strictEqual((yield* fs.stat("/join-a")).ino, (yield* fs.stat("/join-b")).ino)
    }).pipe(Effect.provide(BunCrypto.layer)))

  it.effect("accepts semantically equivalent reordered and renumbered bases but rejects a semantic mutation", () =>
    Effect.gen(function*() {
      const original = yield* Vfs.fromFixture({
        entries: [
          { kind: "directory", path: "/d" },
          { kind: "file", path: "/d/a", bytes: new Uint8Array([1]) },
          { kind: "hardLink", path: "/b", target: "/d/a" }
        ]
      })
      const target = yield* Vfs.fromFixture({
        entries: [
          { kind: "directory", path: "/d" },
          { kind: "file", path: "/d/a", bytes: new Uint8Array([2]) },
          { kind: "hardLink", path: "/b", target: "/d/a" }
        ]
      })
      const base = yield* original.snapshot
      const document = yield* snapshotDocument(base)
      const ids = new Map<string, string>(
        document.records.map((record: { id: string }, index: number) => [record.id, `r${index + 10}`])
      )
      document.root = ids.get(document.root)
      for (const record of document.records) {
        record.id = ids.get(record.id)
        if (record.kind === "directory") { for (const entry of record.entries) entry.target = ids.get(entry.target) }
      }
      document.records.reverse()
      const equivalent = yield* snapshotFromDocument(document)
      const delta = yield* Vfs.diffSnapshots(base, yield* target.snapshot)
      yield* Vfs.applySnapshotDelta(equivalent, delta)

      const changed = structuredClone(document)
      changed.records.find((record: { kind: string }) => record.kind === "file").data = "CQ=="
      const error = yield* Effect.flip(Vfs.applySnapshotDelta(yield* snapshotFromDocument(changed), delta))
      assert.instanceOf(error, Vfs.SnapshotDeltaError)
      assert.strictEqual(error.code, "BaseMismatch")
    }).pipe(Effect.provide(BunCrypto.layer)))

  it.effect("includes every retained semantic component in base identity", () =>
    Effect.gen(function*() {
      const raw = yield* Vfs.pathFromBytes(new Uint8Array([47, 255]))
      const volume = yield* Vfs.fromFixture({
        rootMetadata: { mode: 0o755, uid: 1, gid: 2, atimeNs: 3n, mtimeNs: 4n, ctimeNs: 5n, birthtimeNs: 6n },
        entries: [
          { kind: "directory", path: "/d" },
          { kind: "file", path: "/d/a", bytes: new Uint8Array([1]), metadata: { mode: 0o640, uid: 7 } },
          { kind: "hardLink", path: "/b", target: "/d/a" },
          { kind: "symlink", path: "/link", target: "target" },
          { kind: "file", path: raw, bytes: new Uint8Array([2]) }
        ]
      })
      const base = yield* volume.snapshot
      const delta = yield* Vfs.diffSnapshots(base, base)
      const source = yield* snapshotDocument(base)
      const root = source.records.find((record: { id: string }) => record.id === source.root)
      const file = source.records.find((record: { kind: string; data?: string }) =>
        record.kind === "file" && record.data === "AQ=="
      )
      const symlink = source.records.find((record: { kind: string }) => record.kind === "symlink")
      assert.isDefined(root)
      assert.isDefined(file)
      assert.isDefined(symlink)

      const cases: Array<readonly [string, unknown]> = []
      for (const field of ["mode", "uid", "gid"] as const) {
        const changed = structuredClone(source)
        const changedRoot = changed.records.find((record: { id: string }) => record.id === changed.root)
        changedRoot.metadata[field] += 1
        cases.push([`root ${field}`, changed])
      }
      for (const field of ["atimeNs", "mtimeNs", "ctimeNs", "birthtimeNs"] as const) {
        const changed = structuredClone(source)
        const changedRoot = changed.records.find((record: { id: string }) => record.id === changed.root)
        changedRoot.metadata[field] = String(BigInt(changedRoot.metadata[field]) + 1n)
        cases.push([`root ${field}`, changed])
      }
      {
        const changed = structuredClone(source)
        changed.records.find((record: { id: string }) => record.id === file.id).metadata.mode += 1
        cases.push(["entry metadata", changed])
      }
      {
        const changed = structuredClone(source)
        const changedRoot = changed.records.find((record: { id: string }) => record.id === changed.root)
        changedRoot.entries.find((entry: { name: string }) => entry.name === "/w==").name = "/g=="
        cases.push(["raw path", changed])
      }
      {
        const changed = structuredClone(source)
        const changedFile = changed.records.find((record: { id: string }) => record.id === file.id)
        changedFile.kind = "symlink"
        changedFile.target = changedFile.data
        delete changedFile.data
        cases.push(["node kind", changed])
      }
      {
        const changed = structuredClone(source)
        changed.records.find((record: { id: string }) => record.id === file.id).data = "Ag=="
        cases.push(["file payload", changed])
      }
      {
        const changed = structuredClone(source)
        changed.records.find((record: { id: string }) => record.id === symlink.id).target = "b3RoZXI="
        cases.push(["symlink target", changed])
      }
      {
        const changed = structuredClone(source)
        const changedRoot = changed.records.find((record: { id: string }) => record.id === changed.root)
        const changedFile = changed.records.find((record: { id: string }) => record.id === file.id)
        changed.records.push({ ...structuredClone(changedFile), id: "split" })
        changedRoot.entries.find((entry: { name: string }) => entry.name === "Yg==").target = "split"
        cases.push(["hard-link equivalence", changed])
      }

      for (const [label, changed] of cases) {
        const error = yield* Effect.flip(Vfs.applySnapshotDelta(yield* snapshotFromDocument(changed), delta))
        assert.instanceOf(error, Vfs.SnapshotDeltaError, label)
        assert.strictEqual(error.code, "BaseMismatch", label)
      }
    }).pipe(Effect.provide(BunCrypto.layer)))

  it.effect("applies the output payload budget only to the target", () =>
    Effect.gen(function*() {
      const baseVolume = yield* Vfs.fromFixture({
        entries: [{ kind: "file", path: "/large", bytes: new Uint8Array(128) }]
      })
      const targetVolume = yield* Vfs.fromFixture({ entries: [] })
      const base = yield* baseVolume.snapshot
      const target = yield* targetVolume.snapshot
      const limits = deltaLimitsWith("maxOutputBytes", 0)

      const delta = yield* Vfs.diffSnapshots(base, target, limits)
      assert.strictEqual((yield* Vfs.inspectSnapshotDelta(base, delta, undefined, limits)).length, 1)
      const restored = yield* Vfs.applySnapshotDelta(base, delta, limits)
      assert.deepStrictEqual(
        yield* (yield* Vfs.fromSnapshot(restored)).caller().pipe(Effect.flatMap((fs) => fs.readDirectory("/"))),
        []
      )
    }).pipe(Effect.provide(BunCrypto.layer)))

  it.effect("rejects snapshot path and payload work at the configured boundaries", () =>
    Effect.gen(function*() {
      const empty = yield* (yield* Vfs.fromFixture({ entries: [] })).snapshot
      const payload = yield* (yield* Vfs.fromFixture({
        entries: [{ kind: "file", path: "/f", bytes: new Uint8Array(128) }]
      })).snapshot
      const nested = yield* (yield* Vfs.fromFixture({
        entries: [
          { kind: "directory", path: "/a" },
          { kind: "file", path: "/a/b", bytes: new Uint8Array() }
        ]
      })).snapshot

      const basePayloadError = yield* Effect.flip(
        Vfs.diffSnapshots(payload, empty, deltaLimitsWith("maxIdentityBytes", 127))
      )
      assert.instanceOf(basePayloadError, Vfs.ImageError)
      assert.strictEqual(basePayloadError.code, "LimitExceeded")
      assert.strictEqual(basePayloadError.field, "identityBytes")

      const targetPathError = yield* Effect.flip(
        Vfs.diffSnapshots(empty, nested, deltaLimitsWith("maxDecodedDeltaBytes", 2))
      )
      assert.instanceOf(targetPathError, Vfs.ImageError)
      assert.strictEqual(targetPathError.code, "LimitExceeded")
      assert.strictEqual(targetPathError.field, "decodedDeltaBytes")

      const targetPayloadError = yield* Effect.flip(
        Vfs.diffSnapshots(empty, payload, deltaLimitsWith("maxOutputBytes", 127))
      )
      assert.instanceOf(targetPayloadError, Vfs.ImageError)
      assert.strictEqual(targetPayloadError.code, "LimitExceeded")
      assert.strictEqual(targetPayloadError.field, "outputBytes")
    }).pipe(Effect.provide(BunCrypto.layer)))

  it.effect("orders raw paths deterministically, filters timestamps, and returns fresh frozen owned results", () =>
    Effect.gen(function*() {
      const p80 = yield* Vfs.pathFromBytes(new Uint8Array([47, 128]))
      const pff = yield* Vfs.pathFromBytes(new Uint8Array([47, 255]))
      const base = yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/time", bytes: new Uint8Array() }] })
      const target = yield* Vfs.fromFixture({
        entries: [
          { kind: "file", path: pff, bytes: new Uint8Array() },
          { kind: "file", path: p80, bytes: new Uint8Array() },
          { kind: "file", path: "/time", bytes: new Uint8Array(), metadata: { mtimeNs: 1n } }
        ]
      })
      const baseSnapshot = yield* base.snapshot
      const create = Vfs.diffSnapshots(baseSnapshot, yield* target.snapshot)
      const firstDelta = yield* create
      const secondDelta = yield* create
      assert.notStrictEqual(firstDelta, secondDelta)

      const inspect = Vfs.inspectSnapshotDelta(baseSnapshot, firstDelta, { includeTimestamps: true })
      const first = yield* inspect
      const second = yield* inspect
      assert.notStrictEqual(first, second)
      assert.isTrue(Object.isFrozen(first))
      assert.isTrue(first.every(Object.isFrozen))
      const paths = yield* Effect.forEach(first, (change) => Vfs.pathToBytes(change.path))
      assert.deepStrictEqual(paths, [encoder.encode("/time"), new Uint8Array([47, 128]), new Uint8Array([47, 255])])
      paths[1]![1] = 0
      assert.deepStrictEqual(yield* Vfs.pathToBytes(second[1]!.path), new Uint8Array([47, 128]))

      const filtered = yield* Vfs.inspectSnapshotDelta(baseSnapshot, firstDelta)
      assert.isFalse(filtered.some((change) => change._tag === "Updated" && change.differences.includes("mtimeNs")))
      assert.isTrue(first.some((change) => change._tag === "Updated" && change.differences.includes("mtimeNs")))

      const applied = Vfs.applySnapshotDelta(baseSnapshot, firstDelta)
      const a = yield* (yield* Vfs.fromSnapshot(yield* applied)).caller()
      const b = yield* (yield* Vfs.fromSnapshot(yield* applied)).caller()
      yield* a.unlink(p80)
      assert.strictEqual((yield* b.stat(p80)).kind, "file")
    }).pipe(Effect.provide(BunCrypto.layer)))
})

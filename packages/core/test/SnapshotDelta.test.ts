import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, it } from "@effect/vitest"
import { ByteSize, Effect, Predicate, Schema } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"
import { entryNames, rawEntryNames } from "./support/text.js"

const encoder = new TextEncoder()

const snapshotLimits = {
  maxEncodedBytes: ByteSize.megabytes(1),
  maxRecords: 100,
  maxEntries: 100,
  maxDecodedBytes: ByteSize.kilobytes(100)
}

const snapshotFromDocument = (document: typeof Schema.Unknown.Type) =>
  Vfs.decodeSnapshot(encoder.encode(JSON.stringify(document)), snapshotLimits)

const snapshotDocument = (snapshot: Vfs.Snapshot) =>
  Vfs.encodeSnapshot(snapshot).pipe(Effect.map((bytes) => JSON.parse(new TextDecoder().decode(bytes))))

const deltaLimitsWith = (
  field: "maxIdentityBytes" | "maxDecodedDeltaBytes" | "maxOutputBytes",
  value: number
): Effect.Effect<Vfs.SnapshotDeltaLimits, Schema.SchemaError> => {
  const current = Vfs.SnapshotDeltaLimits.default[field]

  return Schema.decodeEffect(Vfs.SnapshotDeltaLimits)({
    ...Vfs.SnapshotDeltaLimits.default,
    [field]: Schema.is(Schema.BigInt)(current) ? BigInt(value) : value
  })
}

const DeltaIdentity = Schema.fromJsonString(Schema.Struct({
  base: Schema.Struct({ digest: Schema.String })
}))

const FileNode = Schema.TaggedStruct("file", {
  content: Schema.TaggedStruct("Inline", { bytes: Schema.String })
})

interface MutableLink {
  parent: number
  name: string
}

it.layer(BunCrypto.layer)("snapshot deltas", (it) => {
  it.effect("keeps the empty snapshot semantic identity stable", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.fromFixture({
        rootMetadata: { mode: 0o755, uid: 0, gid: 0, atimeNs: 0n, mtimeNs: 0n, ctimeNs: 0n, birthtimeNs: 0n },
        entries: []
      })

      const snapshot = yield* volume.snapshot
      const delta = yield* Vfs.diffSnapshots(snapshot, snapshot)
      const encoded = yield* Schema.encodeEffect(Vfs.SnapshotDeltaFromBytes())(delta)
      const document = yield* Schema.decodeEffect(DeltaIdentity)(new TextDecoder().decode(encoded))
      assert.strictEqual(document.base.digest, "rZYY/SonfmsCbsGkLQjVSfHecxzy6kiNba2QGEmixg0=")
    }))

  // The empty fixture above pins the domain prefix, the algorithm identifier and the object count,
  // but nothing else. This fixture exists to pin the rest of the encoding, one element per feature:
  //
  //   multiple objects, sorted by first path  `/B` before `/a`, which also reverses under locale collation
  //   an object with several paths, sorted    the hard link at `/a` and `/B/a`, declared in the other order
  //   every kind byte                         a directory, a file and a symlink, plus the root directory
  //   uid, gid and mode, in that order        all three distinct per object, so a field swap cannot hide
  //   four timestamps, in that order          all four distinct per object
  //   timestamps as framed decimal text       a negative value and one above 2^53 on `/B`
  //   a non-empty payload                     `/B/a` holds NUL and 0xff, which UTF-8 handling would corrupt
  //   an empty payload                        `/empty`
  //   a symlink payload                       `/link`
  //   a raw, non-UTF-8 byte path              the file at [0xff, 0xfe]
  //
  // A failure here means the identity encoding moved. That is either a regression, or a deliberate
  // change that also requires bumping ALGORITHM in internal/snapshotDelta.ts and updating
  // .okf/contracts/snapshot-deltas.md, because every previously serialised delta stops validating.
  // Do not regenerate this digest on its own.
  it.effect("keeps the populated snapshot semantic identity stable", () =>
    Effect.gen(function*() {
      const raw = yield* Vfs.pathFromBytes(new Uint8Array([47, 255, 254]))

      const volume = yield* Vfs.fromFixture({
        rootMetadata: { mode: 0o755, uid: 1, gid: 2, atimeNs: 3n, mtimeNs: 4n, ctimeNs: 5n, birthtimeNs: 6n },
        entries: [
          {
            kind: "directory",
            path: "/B",
            metadata: {
              mode: 0o750,
              uid: 3,
              gid: 4,
              atimeNs: -1n,
              mtimeNs: 9007199254740993n,
              ctimeNs: 7n,
              birthtimeNs: 8n
            }
          },
          {
            kind: "file",
            path: "/B/a",
            bytes: new Uint8Array([0, 1, 255]),
            metadata: { mode: 0o640, uid: 5, gid: 6, atimeNs: 10n, mtimeNs: 11n, ctimeNs: 12n, birthtimeNs: 13n }
          },
          { kind: "hardLink", path: "/a", target: "/B/a" },
          {
            kind: "file",
            path: "/empty",
            bytes: new Uint8Array([]),
            metadata: { mode: 0o600, uid: 7, gid: 8, atimeNs: 14n, mtimeNs: 15n, ctimeNs: 16n, birthtimeNs: 17n }
          },
          {
            kind: "symlink",
            path: "/link",
            target: "B/a",
            metadata: { mode: 0o777, uid: 9, gid: 10, atimeNs: 18n, mtimeNs: 19n, ctimeNs: 20n, birthtimeNs: 21n }
          },
          {
            kind: "file",
            path: raw,
            bytes: new Uint8Array([254]),
            metadata: { mode: 0o644, uid: 11, gid: 12, atimeNs: 22n, mtimeNs: 23n, ctimeNs: 24n, birthtimeNs: 25n }
          }
        ]
      })

      const snapshot = yield* volume.snapshot
      const delta = yield* Vfs.diffSnapshots(snapshot, snapshot)
      const encoded = yield* Schema.encodeEffect(Vfs.SnapshotDeltaFromBytes())(delta)
      const document = yield* Schema.decodeEffect(DeltaIdentity)(new TextDecoder().decode(encoded))
      assert.strictEqual(document.base.digest, "/Ay2nkhDZycpUnDrUSQzNhSctWHakQaN5xYAgA42SZU=")
    }))

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
        (rawEntryNames(yield* fs.readDirectory("/"))).map((name) => Array.from(name).join(",")).sort(),
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
      assert.deepStrictEqual(yield* fs.readLink("/link"), new Uint8Array([47, 255]))
      assert.strictEqual((yield* Effect.flip(fs.stat("/removed"))).code, "NotFound")
    }))

  it.effect("orders applied directory entries by raw name bytes rather than locale", () =>
    Effect.gen(function*() {
      // Locale collation disagrees with byte order for each of these names, and so does locale
      // collation over their base64 encodings ("/A==", "0A==", "Qg==", "YQ==" reverses the pair
      // order below). A comparator that sorts either spelling as text fails this assertion.
      const localeSensitive = [
        encoder.encode("B"),
        encoder.encode("a"),
        new Uint8Array([0xd0]),
        new Uint8Array([0xfc])
      ]

      const base = yield* Vfs.fromFixture({ entries: [] })

      const target = yield* Vfs.fromFixture({
        entries: [
          ...yield* Effect.forEach(localeSensitive, (name) =>
            Effect.map(
              Vfs.pathFromBytes(new Uint8Array([47, ...name])),
              (path) => ({ kind: "file", path, bytes: new Uint8Array([1]) }) as const
            )),
          // `/dir` exists to separate sorting from record order. Its entries are reached in record
          // order, and the hard link's object sorts under `/a-shared`, so `z-alias` is linked into
          // `/dir` before `b`. Only an actual sort puts them back in byte order.
          { kind: "file", path: "/a-shared", bytes: new Uint8Array([2]) },
          { kind: "directory", path: "/dir" },
          { kind: "file", path: "/dir/b", bytes: new Uint8Array([3]) },
          { kind: "hardLink", path: "/dir/z-alias", target: "/a-shared" }
        ]
      })

      const baseSnapshot = yield* base.snapshot
      const delta = yield* Vfs.diffSnapshots(baseSnapshot, yield* target.snapshot)
      const applied = yield* Vfs.applySnapshotDelta(baseSnapshot, delta)
      const fs = yield* (yield* Vfs.fromSnapshot(applied)).caller()

      assert.deepStrictEqual(rawEntryNames(yield* fs.readDirectory("/")), [
        encoder.encode("B"),
        encoder.encode("a"),
        encoder.encode("a-shared"),
        encoder.encode("dir"),
        new Uint8Array([0xd0]),
        new Uint8Array([0xfc])
      ])
      assert.deepStrictEqual(rawEntryNames(yield* fs.readDirectory("/dir")), [
        encoder.encode("b"),
        encoder.encode("z-alias")
      ])
    }))

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
      assert.isFalse(changes.some(Predicate.isTagged("Renamed")))

      for (const path of ["/join-a", "/join-b", "/split-a", "/split-b"]) {
        const change = changes[names.indexOf(path)]
        assert.strictEqual(change?._tag, "Updated")

        if (change?._tag === "Updated") assert.include(change.differences, "hardLinks")
      }

      assert.deepStrictEqual(changes.slice(2, 6).map((change) => change._tag), ["Added", "Added", "Removed", "Removed"])

      const fs = yield* (yield* Vfs.fromSnapshot(yield* Vfs.applySnapshotDelta(baseSnapshot, delta))).caller()
      assert.notStrictEqual((yield* fs.stat("/split-a")).ino, (yield* fs.stat("/split-b")).ino)
      assert.strictEqual((yield* fs.stat("/join-a")).ino, (yield* fs.stat("/join-b")).ino)
    }))

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

      // Renumber every inode but the root's so the nodes come in the reverse of their original order.
      const inos = new Map<number, number>(
        document.nodes.map((node: { ino: number }, index: number) => [node.ino, index === 0 ? 1 : 100 - index])
      )

      for (const node of document.nodes) {
        node.ino = inos.get(node.ino)

        if (Object.hasOwn(node, "parent")) node.parent = inos.get(node.parent)

        for (const link of node.links ?? []) link.parent = inos.get(link.parent)
      }

      document.nodes.sort((a: { ino: number }, b: { ino: number }) => a.ino - b.ino)
      const equivalent = yield* snapshotFromDocument(document)
      const delta = yield* Vfs.diffSnapshots(base, yield* target.snapshot)
      yield* Vfs.applySnapshotDelta(equivalent, delta)

      const changed = structuredClone(document)
      changed.nodes.find((node: { _tag: string }) => Predicate.isTagged("file")(node)).content.bytes = "CQ=="
      const error = yield* Effect.flip(Vfs.applySnapshotDelta(yield* snapshotFromDocument(changed), delta))
      assert.instanceOf(error, Vfs.VfsError)
      assert.deepStrictEqual([error.code, error.operation], ["BaseMismatch", "applySnapshotDelta"])
    }))

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

      const fileIndex = source.nodes.findIndex((node: { _tag: string }) =>
        Schema.is(FileNode)(node) && node.content.bytes === "AQ=="
      )

      const symlinkIndex = source.nodes.findIndex((node: { _tag: string }) => Predicate.isTagged("symlink")(node))
      assert.isAbove(fileIndex, 0)
      assert.isAbove(symlinkIndex, 0)

      const cases: Array<readonly [string, unknown]> = []

      for (const field of ["mode", "uid", "gid"] as const) {
        const changed = structuredClone(source)
        changed.nodes[0].metadata[field] += 1
        cases.push([`root ${field}`, changed])
      }

      for (const field of ["atimeNs", "mtimeNs", "ctimeNs", "birthtimeNs"] as const) {
        const changed = structuredClone(source)
        changed.nodes[0].metadata[field] = String(BigInt(changed.nodes[0].metadata[field]) + 1n)
        cases.push([`root ${field}`, changed])
      }

      {
        const changed = structuredClone(source)
        changed.nodes[fileIndex].metadata.mode += 1
        cases.push(["entry metadata", changed])
      }

      {
        const changed = structuredClone(source)

        const rawLink = changed.nodes.flatMap((node: { links?: Array<MutableLink> }) => node.links ?? [])
          .find((link: MutableLink) => link.name === "/w==")

        rawLink.name = "/g=="
        cases.push(["raw path", changed])
      }

      {
        const changed = structuredClone(source)
        const changedFile = changed.nodes[fileIndex]
        changedFile._tag = "symlink"
        changedFile.target = changedFile.content.bytes
        delete changedFile.content
        cases.push(["node kind", changed])
      }

      {
        const changed = structuredClone(source)
        changed.nodes[fileIndex].content.bytes = "Ag=="
        cases.push(["file payload", changed])
      }

      {
        const changed = structuredClone(source)
        changed.nodes[symlinkIndex].target = "b3RoZXI="
        cases.push(["symlink target", changed])
      }

      {
        // The file's second name moves to a copy of it, so both paths survive but no longer share an object.
        const changed = structuredClone(source)
        const changedFile = changed.nodes[fileIndex]
        const second = changedFile.links.findIndex((link: MutableLink) => link.name === "Yg==")
        const [moved] = changedFile.links.splice(second, 1)
        const last = changed.nodes.at(-1).ino
        changed.nodes.push({ ...structuredClone(changedFile), ino: last + 1, links: [moved] })
        cases.push(["hard-link equivalence", changed])
      }

      for (const [label, changed] of cases) {
        const error = yield* Effect.flip(Vfs.applySnapshotDelta(yield* snapshotFromDocument(changed), delta))
        assert.instanceOf(error, Vfs.VfsError, label)
        assert.strictEqual(error.code, "BaseMismatch", label)
      }
    }))

  it.effect("applies the output payload budget only to the target", () =>
    Effect.gen(function*() {
      const baseVolume = yield* Vfs.fromFixture({
        entries: [{ kind: "file", path: "/large", bytes: new Uint8Array(128) }]
      })

      const targetVolume = yield* Vfs.fromFixture({ entries: [] })
      const base = yield* baseVolume.snapshot
      const target = yield* targetVolume.snapshot
      const limits = yield* deltaLimitsWith("maxOutputBytes", 0)

      const delta = yield* Vfs.diffSnapshots(base, target, limits)
      assert.strictEqual((yield* Vfs.inspectSnapshotDelta(base, delta, undefined, limits)).length, 1)
      const restored = yield* Vfs.applySnapshotDelta(base, delta, limits)
      assert.deepStrictEqual(
        entryNames(
          yield* (yield* Vfs.fromSnapshot(restored)).caller().pipe(Effect.flatMap((fs) => fs.readDirectory("/")))
        ),
        []
      )
    }))

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
        Vfs.diffSnapshots(payload, empty, yield* deltaLimitsWith("maxIdentityBytes", 127))
      )

      assert.instanceOf(basePayloadError, Vfs.VfsError)
      assert.deepStrictEqual([basePayloadError.code, basePayloadError.operation], ["LimitExceeded", "diffSnapshots"])
      assert.strictEqual(basePayloadError.field, "identityBytes")

      const targetPathError = yield* Effect.flip(
        Vfs.diffSnapshots(empty, nested, yield* deltaLimitsWith("maxDecodedDeltaBytes", 2))
      )

      assert.instanceOf(targetPathError, Vfs.VfsError)
      assert.strictEqual(targetPathError.code, "LimitExceeded")
      assert.strictEqual(targetPathError.field, "decodedDeltaBytes")

      const targetPayloadError = yield* Effect.flip(
        Vfs.diffSnapshots(empty, payload, yield* deltaLimitsWith("maxOutputBytes", 127))
      )

      assert.instanceOf(targetPayloadError, Vfs.VfsError)
      assert.strictEqual(targetPayloadError.code, "LimitExceeded")
      assert.strictEqual(targetPayloadError.field, "outputBytes")
    }))

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
      assert.isFalse(
        filtered.some((change) => Predicate.isTagged("Updated")(change) && change.differences.includes("mtimeNs"))
      )
      assert.isTrue(
        first.some((change) => Predicate.isTagged("Updated")(change) && change.differences.includes("mtimeNs"))
      )

      const applied = Vfs.applySnapshotDelta(baseSnapshot, firstDelta)
      const a = yield* (yield* Vfs.fromSnapshot(yield* applied)).caller()
      const b = yield* (yield* Vfs.fromSnapshot(yield* applied)).caller()
      yield* a.unlink(p80)
      assert.strictEqual((yield* b.stat(p80)).kind, "file")
    }))
})

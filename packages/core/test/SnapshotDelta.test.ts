import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, it } from "@effect/vitest"
import { ByteSize, Crypto, Effect, Exit, Predicate, Schema } from "effect"
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

const DeltaIdentity = Schema.fromJsonString(Schema.Struct({ base: Schema.String }))

const identityOf = Effect.fnUntraced(function*(snapshot: Vfs.Snapshot) {
  const encoded = yield* Schema.encodeEffect(Vfs.SnapshotDeltaFromBytes())(yield* Vfs.diffSnapshots(snapshot, snapshot))

  return (yield* Schema.decodeEffect(DeltaIdentity)(new TextDecoder().decode(encoded))).base
})

const deltaDocument = (delta: Vfs.SnapshotDelta) =>
  Schema.encodeEffect(Vfs.SnapshotDeltaFromBytes())(delta).pipe(
    Effect.map((bytes) => ({ bytes: bytes.length, document: JSON.parse(new TextDecoder().decode(bytes)) }))
  )

// A tree of `directories` directories holding `files` files each, all with fixed metadata.
const tree = (directories: number, files: number) =>
  Vfs.fromFixture({
    entries: Array.from({ length: directories }, (_, d) => [
      { kind: "directory", path: `/d${d}` } as const,
      ...Array.from({ length: files }, (_, f) =>
        ({
          kind: "file",
          path: `/d${d}/f${f}`,
          bytes: new Uint8Array([d, f])
        }) as const)
    ]).flat()
  })

const edit = Effect.fnUntraced(function*(volume: Vfs.Volume, path: string) {
  const caller = yield* volume.caller()
  const base = yield* volume.snapshot
  yield* caller.writeFile(path, new Uint8Array([9, 9, 9]), { access: "write", truncate: true })

  return { base, target: yield* volume.snapshot }
})

const FileNode = Schema.TaggedStruct("file", {
  content: Schema.TaggedStruct("Inline", { bytes: Schema.String })
})

interface MutableLink {
  parent: number
  name: string
}

it.layer(BunCrypto.layer)("snapshot deltas", (it) => {
  // Both digests were regenerated when the identity became a Merkle tree: each node's digest covers its kind,
  // metadata and payload, a directory's covers its entries' names and child digests in name-byte order, and the
  // snapshot's covers the root digest and its hard-link groups. The layout changed under the same algorithm
  // identifier, as decided for the 0.6.0 release, so deltas serialised before it no longer validate.
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
      assert.strictEqual(document.base, "Cvxnm9EjfvdhwMidAWBmx6OChcHENX1q4z+bCp//d98=")
    }))

  // The empty fixture above pins the domain prefix, the algorithm identifier, the root directory's node
  // encoding and the empty group list, but nothing else. This fixture exists to pin the rest of the encoding,
  // one element per feature:
  //
  //   entries sorted by name bytes            `/B` before `/a`, which also reverses under locale collation
  //   a hard-link group, its paths sorted     the hard link at `/a` and `/B/a`, declared in the other order
  //   a child digest under a subdirectory     `/B/a` sits under `/B`, so the root covers `/B`'s digest
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
  // change that also requires bumping ALGORITHM in internal/merkle.ts and updating
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
      assert.strictEqual(document.base, "Uhdurw2p97cieGz/65CbuqV4LyAC04GiwBbZJOziwnQ=")
    }))

  it.effect("identifies hard-link groups but not inode numbers", () =>
    Effect.gen(function*() {
      const metadata = { mode: 0o644, uid: 1, gid: 1, atimeNs: 1n, mtimeNs: 1n, ctimeNs: 1n, birthtimeNs: 1n }
      const file = (path: string) => ({ kind: "file", path, bytes: new Uint8Array([1]), metadata }) as const

      // Every name holds the same bytes and metadata, so the trees differ only in which names share a node.
      const aLinked = yield* Vfs.fromFixture({
        entries: [file("/a"), { kind: "hardLink", path: "/b", target: "/a" }, file("/c")]
      })

      const cLinked = yield* Vfs.fromFixture({
        entries: [file("/a"), file("/b"), { kind: "hardLink", path: "/c", target: "/b" }]
      })

      const unlinked = yield* Vfs.fromFixture({ entries: [file("/a"), file("/b"), file("/c")] })
      const base = yield* aLinked.snapshot
      const identities = yield* Effect.forEach([base, yield* cLinked.snapshot, yield* unlinked.snapshot], identityOf)
      assert.strictEqual(new Set(identities).size, 3)

      // The same groups under other inode numbers, stored in another order, keep the identity.
      const document = yield* snapshotDocument(base)
      const renumber = (ino: number) => (ino === 1 ? 1 : 1_000 - ino)

      for (const node of document.nodes) {
        node.ino = renumber(node.ino)

        if (Object.hasOwn(node, "parent")) node.parent = renumber(node.parent)

        for (const link of node.links ?? []) link.parent = renumber(link.parent)
      }

      document.nodes.sort((a: { ino: number }, b: { ino: number }) => a.ino - b.ino)
      assert.strictEqual(yield* identityOf(yield* snapshotFromDocument(document)), identities[0])
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

  it.effect("numbers an applied node up to the largest inode a decoded tree allows, and no further", () =>
    Effect.gen(function*() {
      const target = yield* (yield* Vfs.fromFixture({
        entries: [
          { kind: "file", path: "/f", bytes: new Uint8Array([1]) },
          { kind: "directory", path: "/g" }
        ]
      })).snapshot

      const numbered = Effect.fnUntraced(function*(ino: number) {
        const document = yield* snapshotDocument(
          yield* (yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/f", bytes: new Uint8Array([1]) }] }))
            .snapshot
        )

        document.nodes[1].ino = ino

        return yield* snapshotFromDocument(document)
      })

      // A tree holds inode numbers up to one below the largest safe integer, so the allocator stays exact.
      const roomy = yield* numbered(Number.MAX_SAFE_INTEGER - 2)
      const applied = yield* Vfs.applySnapshotDelta(roomy, yield* Vfs.diffSnapshots(roomy, target))
      const restored = yield* snapshotFromDocument(yield* snapshotDocument(applied))
      assert.deepStrictEqual(yield* Vfs.inspectSnapshotDelta(restored, yield* Vfs.diffSnapshots(restored, target)), [])

      const full = yield* numbered(Number.MAX_SAFE_INTEGER - 1)
      const error = yield* Effect.flip(Vfs.applySnapshotDelta(full, yield* Vfs.diffSnapshots(full, target)))
      assert.instanceOf(error, Vfs.VfsError)
      assert.deepStrictEqual([error.code, error.field], ["LimitExceeded", "inodes"])
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

  it.effect("refuses on apply and inspect exactly the identity bytes a diff to the same target refuses", () =>
    Effect.gen(function*() {
      const grownFrom = Effect.fnUntraced(function*(volume: Vfs.Volume, path: string, bytes: number) {
        const base = yield* volume.snapshot
        yield* (yield* volume.caller()).writeFile(path, new Uint8Array(bytes).fill(7), {
          access: "write",
          create: "exclusive"
        })

        return { base, target: yield* volume.snapshot }
      })

      const at = (bytes: number) => deltaLimitsWith("maxIdentityBytes", bytes)

      // The smallest maxIdentityBytes under which `run` succeeds: double to a bound that succeeds, then bisect.
      const threshold = Effect.fnUntraced(function*<E>(
        run: (limits: Vfs.SnapshotDeltaLimits) => Effect.Effect<unknown, E, Crypto.Crypto>
      ) {
        let low = 1
        let high = 1024

        while (Exit.isFailure(yield* Effect.exit(run(yield* at(high))))) {
          low = high + 1
          high *= 2
        }

        while (low < high) {
          const middle = Math.floor((low + high) / 2)
          const exit = yield* Effect.exit(run(yield* at(middle)))

          if (Exit.isSuccess(exit)) high = middle
          else low = middle + 1
        }

        return low
      })

      // A target that grows past its base, one that drops most of what its base holds, and a one-file rewrite.
      const grown = yield* grownFrom(yield* tree(6, 6), "/big", 4_000)
      const shrunk = { base: grown.target, target: grown.base }
      const edited = yield* edit(yield* tree(6, 6), "/d3/f5")

      for (
        const [label, { base, target }] of [["grown", grown], ["shrunk", shrunk], ["edited", edited]] as const
      ) {
        const delta = yield* Vfs.diffSnapshots(base, target)
        const diffAt = yield* threshold((limits) => Vfs.diffSnapshots(base, target, limits))
        const applyAt = yield* threshold((limits) => Vfs.applySnapshotDelta(base, delta, limits))
        const inspectAt = yield* threshold((limits) => Vfs.inspectSnapshotDelta(base, delta, undefined, limits))
        assert.deepStrictEqual([applyAt, inspectAt], [diffAt, diffAt], label)
        const error = yield* Effect.flip(Vfs.applySnapshotDelta(base, delta, yield* at(diffAt - 1)))
        assert.instanceOf(error, Vfs.VfsError)
        assert.deepStrictEqual([error.code, error.field], ["LimitExceeded", "identityBytes"], label)
      }
    }))

  it.effect("refuses even a root-only snapshot when its record limit is zero", () =>
    Effect.gen(function*() {
      const empty = yield* (yield* Vfs.fromFixture({ entries: [] })).snapshot
      const delta = yield* Vfs.diffSnapshots(empty, empty)

      const refused = Effect.fnUntraced(function*<A, E>(attempt: Effect.Effect<A, E, Crypto.Crypto>, field: string) {
        const error = yield* Effect.flip(attempt)
        assert.instanceOf(error, Vfs.VfsError)
        assert.deepStrictEqual([error.code, error.field], ["LimitExceeded", field])
      })

      for (
        const [limits, field] of [
          [{ ...Vfs.SnapshotDeltaLimits.default, maxBaseRecords: 0 }, "baseRecords"],
          [{ ...Vfs.SnapshotDeltaLimits.default, maxTargetRecords: 0 }, "targetRecords"]
        ] as const
      ) {
        yield* refused(Vfs.diffSnapshots(empty, empty, limits), field)
        yield* refused(Vfs.applySnapshotDelta(empty, delta, limits), field)
        yield* refused(Vfs.inspectSnapshotDelta(empty, delta, undefined, limits), field)
      }
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

  it.effect("carries only the changed node, so a one-file edit is one change whatever the tree's size", () =>
    Effect.gen(function*() {
      const sizes: Array<number> = []

      for (const directories of [2, 40]) {
        const { base, target } = yield* edit(yield* tree(directories, 50), "/d1/f7")
        const { bytes, document } = yield* deltaDocument(yield* Vfs.diffSnapshots(base, target))
        assert.deepStrictEqual(document.changes.map((change: { _tag: string }) => change._tag), ["Updated"])
        assert.deepStrictEqual(document.changes[0].differences, ["content"])
        assert.deepStrictEqual(document.changes[0].node.content, { _tag: "Inline", bytes: "CQkJ" })
        sizes.push(bytes)
      }

      // 101 nodes and 2,041 nodes produce deltas of the same size.
      assert.strictEqual(sizes[0], sizes[1])
    }))

  it.effect("keeps an unchanged payload out of a metadata-only change", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/f", bytes: new Uint8Array(64) }] })
      const base = yield* volume.snapshot
      yield* (yield* volume.caller()).chmod("/f", 0o600)
      const delta = yield* Vfs.diffSnapshots(base, yield* volume.snapshot)
      const { document } = yield* deltaDocument(delta)
      assert.deepStrictEqual(document.changes[0].differences, ["mode"])
      assert.notProperty(document.changes[0].node, "content")

      const fs = yield* (yield* Vfs.fromSnapshot(yield* Vfs.applySnapshotDelta(base, delta))).caller()
      assert.deepStrictEqual(yield* fs.readFile("/f"), new Uint8Array(64))
      assert.strictEqual((yield* fs.stat("/f")).mode, 0o600)
    }))

  it.effect("skips subtrees whose digests agree but still reports a hard link that joins one", () =>
    Effect.gen(function*() {
      const base = yield* Vfs.fromFixture({
        entries: [
          { kind: "directory", path: "/d" },
          { kind: "file", path: "/d/a", bytes: new Uint8Array([1]) },
          { kind: "file", path: "/d/b", bytes: new Uint8Array([2]) }
        ]
      })

      // `/d` holds the same nodes on both sides, so its digest agrees and the walk does not descend into it; only
      // the hard-link groups show that `/d/a` now shares its node with `/x`.
      const target = yield* Vfs.fromFixture({
        entries: [
          { kind: "directory", path: "/d" },
          { kind: "file", path: "/d/a", bytes: new Uint8Array([1]) },
          { kind: "file", path: "/d/b", bytes: new Uint8Array([2]) },
          { kind: "hardLink", path: "/x", target: "/d/a" }
        ]
      })

      const baseSnapshot = yield* base.snapshot
      const delta = yield* Vfs.diffSnapshots(baseSnapshot, yield* target.snapshot)
      const changes = yield* Vfs.inspectSnapshotDelta(baseSnapshot, delta)

      const summary = yield* Effect.forEach(changes, (change) =>
        Effect.map(Vfs.pathToBytes(change.path), (path) => [
          new TextDecoder().decode(path),
          Predicate.isTagged("Updated")(change) ? change.differences : change.kind
        ]))

      assert.deepStrictEqual(summary, [["/d/a", ["hardLinks"]], ["/x", "file"]])
      const { document } = yield* deltaDocument(delta)
      assert.deepStrictEqual(document.changes[1].node, { _tag: "link", to: "L2QvYQ==" })

      const fs = yield* (yield* Vfs.fromSnapshot(yield* Vfs.applySnapshotDelta(baseSnapshot, delta))).caller()
      assert.strictEqual((yield* fs.stat("/d/a")).ino, (yield* fs.stat("/x")).ino)
      assert.strictEqual((yield* fs.stat("/d/a")).nlink, 2)
    }))

  it.effect("digests only what an applied delta rewrote and reuses the base's digests elsewhere", () =>
    Effect.gen(function*() {
      let digests = 0
      const crypto = yield* Crypto.Crypto

      const counting = Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (algorithm, data) => {
          digests++

          return crypto.digest(algorithm, data)
        }
      })

      // The root, 20 directories and 1,000 files.
      const nodes = 1 + 20 + 20 * 50
      const { base, target } = yield* edit(yield* tree(20, 50), "/d3/f9")
      const delta = yield* Vfs.diffSnapshots(base, target)
      digests = 0
      yield* Vfs.applySnapshotDelta(base, delta).pipe(Effect.provideService(Crypto.Crypto, counting))

      // One walk of the base with its identity, then the edited file, its directory and the root, and the target's
      // identity: nothing else in the target is digested again.
      assert.strictEqual(digests, nodes + 1 + 3 + 1)
    }))

  it.effect("rejects a delta against any base but its own", () =>
    Effect.gen(function*() {
      const { base, target } = yield* edit(yield* tree(2, 2), "/d0/f0")
      const other = yield* (yield* tree(2, 3)).snapshot
      const delta = yield* Vfs.diffSnapshots(base, target)

      const errors = [
        yield* Effect.flip(Vfs.applySnapshotDelta(other, delta)),
        yield* Effect.flip(Vfs.inspectSnapshotDelta(other, delta)),
        // Applying to its own target is a mismatch too: a delta does not apply twice.
        yield* Effect.flip(Vfs.applySnapshotDelta(target, delta))
      ]

      for (const error of errors) {
        assert.instanceOf(error, Vfs.VfsError)
        assert.strictEqual(error.code, "BaseMismatch")
      }
    }))

  it.effect("applies to a snapshot with the target's identity, which then inspects as unchanged", () =>
    Effect.gen(function*() {
      const volume = yield* tree(3, 3)
      const caller = yield* volume.caller()
      const base = yield* volume.snapshot
      yield* caller.writeFile("/d0/f0", new Uint8Array([7]), { access: "write", truncate: true })
      yield* caller.chmod("/d1", 0o700)
      yield* caller.unlink("/d2/f2")
      yield* caller.link("/d0/f1", "/d2/shared")
      yield* caller.mkdir("/new")
      yield* caller.symlink("d0", "/new/link")
      const target = yield* volume.snapshot

      const delta = yield* Vfs.diffSnapshots(base, target)
      const applied = yield* Vfs.applySnapshotDelta(base, delta)
      assert.strictEqual(yield* identityOf(applied), yield* identityOf(target))
      assert.deepStrictEqual(yield* Vfs.inspectSnapshotDelta(applied, yield* Vfs.diffSnapshots(applied, target)), [])

      // The applied snapshot is an ordinary one: its bytes decode, and a delta from it applies again.
      const decoded = yield* snapshotFromDocument(yield* snapshotDocument(applied))
      assert.strictEqual(yield* identityOf(decoded), yield* identityOf(target))
      const back = yield* Vfs.diffSnapshots(applied, base)
      assert.strictEqual(yield* identityOf(yield* Vfs.applySnapshotDelta(decoded, back)), yield* identityOf(base))
    }))

  it.effect("carries an overlay's changes and capture across an applied delta", () =>
    Effect.gen(function*() {
      const { base, target } = yield* edit(yield* tree(2, 2), "/d0/f0")
      const applied = yield* Vfs.applySnapshotDelta(base, yield* Vfs.diffSnapshots(base, target))
      const overlay = yield* Vfs.makeOverlay(applied)
      const caller = yield* overlay.caller()
      yield* caller.writeFile("/d1/f1", new Uint8Array([5]), { access: "write", truncate: true })
      yield* caller.unlink("/d0/f0")

      const changes = yield* overlay.changes()
      assert.deepStrictEqual(changes.map((change) => change._tag), ["Removed", "Updated"])
      const { snapshot } = yield* overlay.capture()

      const delta = yield* Vfs.diffSnapshots(applied, snapshot)
      const inspected = yield* Vfs.inspectSnapshotDelta(applied, delta)
      assert.deepStrictEqual(inspected.map((change) => change._tag), ["Removed", "Updated"])
      assert.strictEqual(yield* identityOf(yield* Vfs.applySnapshotDelta(applied, delta)), yield* identityOf(snapshot))
    }))
})

import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, it } from "@effect/vitest"
import { ByteSize, type Crypto, Effect, Exit, Predicate, Schema } from "effect"
import * as Base64 from "effect/encoding/Base64"
import { Testing, VirtualFileSystem as Vfs } from "../src/index.js"
import { type Document, documentText, toLines } from "./support/lines.js"
import { entryNames, rawEntryNames } from "./support/text.js"

const encoder = new TextEncoder()

const snapshotLimits = {
  maxEncodedBytes: ByteSize.megabytes(1),
  maxRecords: 100,
  maxEntries: 100,
  maxDecodedBytes: ByteSize.kilobytes(100)
}

const snapshotFromDocument = (document: Document) => Vfs.decodeSnapshot(toLines(document), snapshotLimits)

const snapshotDocument = (snapshot: Vfs.Snapshot) =>
  Vfs.encodeSnapshot(snapshot).pipe(Effect.map((bytes) => JSON.parse(documentText(bytes))))

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
  it.effect("should keep the empty snapshot semantic identity stable when empty snapshots are compared", () =>
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
  it.effect("should keep the populated snapshot semantic identity stable when a populated snapshot is rebuilt", () =>
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

  it.effect("should identify hard-link groups but not inode numbers when inode numbers differ but hard-link topology matches", () =>
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

  it.effect("should reconstruct node kinds, raw paths, payloads, and every retained metadata field when a delta is applied to a varied tree", () =>
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

  it.effect("should order applied directory entries by raw name bytes rather than locale when directory names have nonlocale byte order", () =>
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

  it.effect("should report path evidence when paths are renamed or hard links split and join", () =>
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

  it.effect("should accept reordered bases but reject semantic changes when base nodes are renumbered", () =>
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

  it.effect("should include every retained semantic component in base identity when one retained semantic component changes", () =>
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

      const cases: Array<readonly [string, Document]> = []

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

  it.effect("should apply the output payload budget only to the target when the base exceeds the target output budget", () =>
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

  it.effect("should number an applied node up to the largest inode a decoded tree allows, and no further when an applied tree approaches its inode ceiling", () =>
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

  it.effect("should reject snapshot path and payload work at the configured boundaries when path or payload limits are reached", () =>
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

  it.effect("should refuse on apply and inspect exactly the identity bytes a diff to the same target refuses when identity byte limits are reached", () =>
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

  it.effect("should refuse even a root-only snapshot when its record limit is zero", () =>
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

  it.effect("should order paths filter timestamps and own results when delta output is inspected", () =>
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

  it.effect("should carry only the changed node, so a one-file edit is one change whatever the tree's size when one file changes in a large tree", () =>
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

  it.effect("should keep an unchanged payload out of a metadata-only change when only metadata changes", () =>
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

  it.effect("should skip subtrees whose digests agree but still reports a hard link that joins one when equal-digest subtrees contain a new hard link", () =>
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

  it.effect("should reject a delta against any base but its own when a different base is supplied", () =>
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

  it.effect("should apply to a snapshot with the target's identity, which then inspects as unchanged when the applied result is compared with its target", () =>
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

  it.effect("should carry an overlay's changes and capture across an applied delta when an overlay is built on the applied result", () =>
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

{
  const encoder = new TextEncoder()

  const decoder = new TextDecoder()

  interface StoredNode {
    _tag: string
    metadata?: object
    content?: { _tag: string; bytes: string }
    target?: string
    to?: string
  }

  interface StoredChange {
    _tag: string
    path: string
    kind?: string
    beforeKind?: string
    afterKind?: string
    differences?: Array<string>
    node?: StoredNode
  }

  interface StoredDocument {
    readonly base: string
    readonly target: string
    readonly version: number
    readonly changes: ReadonlyArray<StoredChange>
  }

  const snapshots = Effect.gen(function*() {
    const volume = yield* Vfs.Volume
    const caller = yield* Vfs.Caller
    const base = yield* volume.snapshot
    yield* caller.writeFile("/f", new Uint8Array([1, 2, 3]), { access: "write", create: "ifMissing" })
    const target = yield* volume.snapshot

    return { base, target }
  }).pipe(Effect.provide(Testing.layer()))

  const encodedDelta = Effect.gen(function*() {
    const pair = yield* snapshots
    const delta = yield* Vfs.diffSnapshots(pair.base, pair.target)
    const encoded = yield* Schema.encodeEffect(Vfs.SnapshotDeltaFromBytes())(delta)

    return { ...pair, encoded }
  })

  const document = (input: Uint8Array): StoredDocument => {
    // SAFETY: The helper only reads snapshots encoded by this package in the test setup.
    return JSON.parse(decoder.decode(input)) as StoredDocument
  }

  const encodeDocument = (value: typeof Schema.Unknown.Type): Uint8Array => encoder.encode(JSON.stringify(value))

  const customLimits = (overrides: Partial<Vfs.SnapshotDeltaLimits>): Vfs.SnapshotDeltaLimits => ({
    ...Vfs.SnapshotDeltaLimits.default,
    ...overrides
  })

  const reject = (input: Uint8Array, limits = Vfs.SnapshotDeltaLimits.default) =>
    Effect.flip(Schema.decodeEffect(Vfs.SnapshotDeltaFromBytes(limits))(input))

  it.layer(BunCrypto.layer)("snapshot delta Schema codec", (it) => {
    it.effect("should round trip through the public Schema and own buffers when decoding and encoding a delta", () =>
      Effect.gen(function*() {
        const { base, encoded } = yield* encodedDelta
        const input = new Uint8Array(encoded)
        const delta = yield* Schema.decodeEffect(Vfs.SnapshotDeltaFromBytes())(input)
        input.fill(0)

        const first = yield* Schema.encodeEffect(Vfs.SnapshotDeltaFromBytes())(delta)
        const expected = new Uint8Array(first)
        first.fill(0)
        const second = yield* Schema.encodeEffect(Vfs.SnapshotDeltaFromBytes())(delta)

        assert.deepStrictEqual(second, expected)
        const restored = yield* Vfs.applySnapshotDelta(base, delta)
        const caller = yield* (yield* Vfs.fromSnapshot(restored)).caller()
        assert.deepStrictEqual(yield* caller.readFile("/f"), new Uint8Array([1, 2, 3]))
      }))

    it.effect("should reject malformed UTF-8, JSON, unknown fields, and unsupported versions when wire text or version is invalid", () =>
      Effect.gen(function*() {
        const { encoded } = yield* encodedDelta
        const source = document(encoded)

        const cases = [
          new Uint8Array([0xc3, 0x28]),
          encoder.encode("{"),
          encodeDocument({ ...source, unexpected: true }),
          encodeDocument({ ...source, changes: [{ ...source.changes[0], unexpected: true }] }),
          encodeDocument({ ...source, version: 2 })
        ]

        for (const input of cases) assert.isDefined(yield* reject(input))
      }))

    it.effect("should reject noncanonical base64, invalid digests, paths, and payloads when encoded bytes or digests are noncanonical", () =>
      Effect.gen(function*() {
        const { encoded } = yield* encodedDelta
        const source = document(encoded)
        const added = source.changes[0]!
        const node = added.node!

        const encodingCases = [
          [{ ...source, base: "A" }, "digest"],
          [{ ...source, target: "A" }, "digest"],
          [{ ...source, base: source.base.slice(4) }, "digest"],
          [{ ...source, changes: [{ ...added, path: "A" }] }, "changePath"],
          [
            { ...source, changes: [{ ...added, node: { ...node, content: { _tag: "Inline", bytes: "A" } } }] },
            "payload"
          ],
          [{ ...source, changes: [{ ...added, node: { _tag: "link", to: "A" } }] }, "changes.0.node.to"]
        ] as const

        for (const [value, field] of encodingCases) {
          const error = yield* reject(encodeDocument(value))
          assert.instanceOf(error, Schema.SchemaError)
          assert.include(String(error), `Snapshot delta InvalidEncoding at ${field}`)
        }

        const structuralCases = [
          [{ ...source, target: `${source.target.slice(0, -2)}h==` }, "InvalidEncoding at digest"],
          [{ ...source, changes: [{ ...added, path: "Lg==" }] }, "InvalidStructure at changes"],
          // One byte past NAME_MAX, which the snapshot tree and fixtures refuse as well.
          [
            { ...source, changes: [{ ...added, path: Base64.encode(`/${"a".repeat(256)}`) }] },
            "InvalidStructure at changes"
          ],
          [{ ...source, changes: [{ ...added, node: { ...node, _tag: "directory" } }] }, "changes.0.node"],
          [{ ...source, changes: [{ ...added, node: { ...node, content: undefined } }] }, "changes.0.node"],
          [
            {
              ...source,
              changes: [{
                ...added,
                kind: "symlink",
                node: { ...node, _tag: "symlink", content: undefined, target: "AA==" }
              }]
            },
            "changes.0.node.target"
          ],
          [
            { ...source, changes: [{ ...added, node: { ...node, content: { _tag: "Inline", bytes: "AQI" } } }] },
            "payload"
          ],
          [{ ...source, changes: [{ _tag: "Removed", path: "Lw==", kind: "directory" }] }, "changes.0"],
          [{ ...source, changes: [{ ...added, node: { _tag: "link", to: added.path } }] }, "changes.0.node.to"]
        ] as const

        for (const [value, site] of structuralCases) {
          assert.include(String(yield* reject(encodeDocument(value))), site)
        }
      }))

    it.effect("should reject updates whose differences are out of order, repeated, or misstate a kind change when updates are out of order or inconsistent", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/f", new Uint8Array([1]), { access: "write", create: "ifMissing" })
        const base = yield* volume.snapshot
        yield* caller.writeFile("/f", new Uint8Array([2]), { access: "write", truncate: true })
        yield* caller.chmod("/f", 0o600)
        const target = yield* volume.snapshot
        const encoded = yield* Schema.encodeEffect(Vfs.SnapshotDeltaFromBytes())(yield* Vfs.diffSnapshots(base, target))
        const source = document(encoded)
        const updated = source.changes.find(Predicate.isTagged("Updated"))!
        assert.deepStrictEqual(updated.differences?.slice(0, 2), ["content", "mode"])
        const differences = updated.differences!

        for (
          const forged of [
            [...differences].reverse(),
            [differences[0]!, ...differences],
            ["kind", ...differences]
          ]
        ) {
          const changes = source.changes.map((change) =>
            change === updated ? { ...change, differences: forged } : change
          )

          assert.include(String(yield* reject(encodeDocument({ ...source, changes }))), "differences")
        }
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should reject unordered, duplicate, and semantically inconsistent summaries when summaries are duplicated or inconsistent", () =>
      Effect.gen(function*() {
        const { base, encoded } = yield* encodedDelta
        const source = document(encoded)
        const added = source.changes[0]
        assert.isDefined(yield* reject(encodeDocument({ ...source, changes: [added, added] })))
        assert.isDefined(
          yield* reject(encodeDocument({
            ...source,
            changes: [
              { _tag: "Added", path: "L3o=", kind: "file" },
              { _tag: "Added", path: "L2E=", kind: "file" }
            ]
          }))
        )

        const inconsistent = yield* Schema.decodeEffect(Vfs.SnapshotDeltaFromBytes())(
          encodeDocument({ ...source, changes: [] })
        )

        const inspectionError = yield* Effect.flip(Vfs.inspectSnapshotDelta(base, inconsistent))
        assert.instanceOf(inspectionError, Vfs.VfsError)
        assert.strictEqual(inspectionError.code, "InvalidStructure")
        assert.strictEqual(inspectionError.field, "changes")
        const error = yield* Effect.flip(Vfs.applySnapshotDelta(base, inconsistent))
        assert.instanceOf(error, Vfs.VfsError)
        assert.strictEqual(error.code, "InvalidStructure")
        assert.strictEqual(error.field, "changes")
      }))

    it.effect("should accept a semantically identical summary with reordered object keys when summary object keys are reordered", () =>
      Effect.gen(function*() {
        const { base, encoded } = yield* encodedDelta
        const source = document(encoded)
        const change = source.changes[0]!
        const reordered = Object.fromEntries(Object.entries(change).reverse())

        const delta = yield* Schema.decodeEffect(Vfs.SnapshotDeltaFromBytes())(
          encodeDocument({ ...source, changes: [reordered] })
        )

        yield* Vfs.applySnapshotDelta(base, delta)
      }))

    it.effect("should accept exact codec boundaries and reject smaller budgets when input reaches the boundary", () =>
      Effect.gen(function*() {
        const { encoded } = yield* encodedDelta
        const source = document(encoded)
        // Both digests, the path `/f` and its three payload bytes.
        const decodedBytes = 32 + 32 + 2 + 3

        const boundaries: ReadonlyArray<readonly [Vfs.SnapshotDeltaLimits, Vfs.SnapshotDeltaLimits]> = [
          [
            customLimits({ maxEncodedBytes: ByteSize.bytes(encoded.length) }),
            customLimits({ maxEncodedBytes: ByteSize.bytes(encoded.length - 1) })
          ],
          [
            customLimits({ maxDeltaRecords: source.changes.length }),
            customLimits({ maxDeltaRecords: source.changes.length - 1 })
          ],
          [
            customLimits({ maxDecodedDeltaBytes: ByteSize.bytes(decodedBytes) }),
            customLimits({ maxDecodedDeltaBytes: ByteSize.bytes(decodedBytes - 1) })
          ],
          [customLimits({ maxEntries: 1 }), customLimits({ maxEntries: 0 })],
          [customLimits({ maxOutputBytes: ByteSize.bytes(3) }), customLimits({ maxOutputBytes: ByteSize.bytes(2) })]
        ]

        for (const [accepted, rejected] of boundaries) {
          assert.isDefined(
            yield* Schema.decodeEffect(Vfs.SnapshotDeltaFromBytes(accepted))(encoded)
          )
          assert.isDefined(yield* reject(encoded, rejected))
        }
      }))

    it.effect("should bound the applied target's nodes at exactly the configured output records when the target reaches its output record limit", () =>
      Effect.gen(function*() {
        const { base, encoded } = yield* encodedDelta
        const delta = yield* Schema.decodeEffect(Vfs.SnapshotDeltaFromBytes())(encoded)

        // The target holds the root and `/f`.
        yield* Vfs.applySnapshotDelta(base, delta, customLimits({ maxOutputRecords: 2 }))
        const error = yield* Effect.flip(Vfs.applySnapshotDelta(base, delta, customLimits({ maxOutputRecords: 1 })))
        assert.instanceOf(error, Vfs.VfsError)
        assert.deepStrictEqual([error.code, error.field], ["LimitExceeded", "outputRecords"])
      }))

    it.effect("should preserve byte limits above Number.MAX_SAFE_INTEGER when configured byte limits exceed safe integers", () =>
      Effect.gen(function*() {
        const { base, target } = yield* snapshots
        const exactLimit = ByteSize.bytes(BigInt(Number.MAX_SAFE_INTEGER) + 1n)

        const limits = customLimits({
          maxEncodedBytes: exactLimit,
          maxIdentityBytes: exactLimit,
          maxDecodedDeltaBytes: exactLimit,
          maxOutputBytes: exactLimit
        })

        const delta = yield* Vfs.diffSnapshots(base, target, limits)
        const codec = Vfs.SnapshotDeltaFromBytes(limits)
        const encoded = yield* Schema.encodeEffect(codec)(delta)
        const decoded = yield* Schema.decodeEffect(codec)(encoded)
        const restored = yield* Vfs.applySnapshotDelta(base, decoded, limits)
        const caller = yield* (yield* Vfs.fromSnapshot(restored)).caller()
        assert.deepStrictEqual(yield* caller.readFile("/f"), new Uint8Array([1, 2, 3]))
      }))

    it.effect("should enforce inherited-record, delta-record, identity and target limits on inspection and apply when inherited delta identity or target limits are reached", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/f", new Uint8Array([1]), { access: "write", create: "ifMissing" })
        const base = yield* volume.snapshot
        const unchanged = yield* Vfs.diffSnapshots(base, base)

        // An unchanged delta carries no node, so the target inherits the root and `/f` from the base.
        yield* Vfs.applySnapshotDelta(base, unchanged, customLimits({ maxInheritedRecords: 2 }))
        yield* caller.writeFile("/g", new Uint8Array([2]), { access: "write", create: "exclusive" })
        const grown = yield* Vfs.diffSnapshots(base, yield* volume.snapshot)

        for (
          const [delta, limits, field] of [
            [unchanged, customLimits({ maxInheritedRecords: 1 }), "inheritedRecords"],
            [grown, customLimits({ maxDeltaRecords: 0 }), "deltaRecords"],
            [unchanged, customLimits({ maxIdentityBytes: ByteSize.zero }), "identityBytes"],
            // The target holds the root, `/f` and `/g`: three records and two names, as a diff under these limits
            // would also refuse.
            [grown, customLimits({ maxTargetRecords: 2 }), "targetRecords"],
            [grown, customLimits({ maxEntries: 1 }), "entries"]
          ] as const
        ) {
          const errors = [
            yield* Effect.flip(Vfs.applySnapshotDelta(base, delta, limits)),
            yield* Effect.flip(Vfs.inspectSnapshotDelta(base, delta, undefined, limits))
          ]

          for (const error of errors) {
            assert.instanceOf(error, Vfs.VfsError)
            assert.deepStrictEqual([error.code, error.field], ["LimitExceeded", field])
          }
        }
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should reject a hard link redirected to a path that carries no node when a hard link targets no node", () =>
      Effect.gen(function*() {
        const empty = yield* (yield* Vfs.fromFixture({ entries: [] })).snapshot

        const linked = yield* Vfs.fromFixture({
          entries: [
            { kind: "file", path: "/a", bytes: new Uint8Array([1]) },
            { kind: "hardLink", path: "/b", target: "/a" },
            { kind: "file", path: "/c", bytes: new Uint8Array([1]) }
          ]
        })

        const delta = yield* Vfs.diffSnapshots(empty, yield* linked.snapshot)
        const source = document(yield* Schema.encodeEffect(Vfs.SnapshotDeltaFromBytes())(delta))
        const link = source.changes.find((change) => change.node?._tag === "link")
        assert.deepStrictEqual(link?.node, { _tag: "link", to: "L2E=" })

        // `/c` comes after `/b`, and `/b` is itself a link: neither is an earlier change's node.
        for (const to of ["L2M=", "L2I=", "L3o="]) {
          const changes = source.changes.map((change) =>
            change === link ? { ...change, node: { _tag: "link", to } } : change
          )

          const error = yield* reject(encodeDocument({ ...source, changes }))
          assert.instanceOf(error, Schema.SchemaError)
          assert.include(String(error), "InvalidStructure at changes.1.node.to")
        }
      }))

    it.effect("should reject on apply a change the base or the target does not bear out when a claimed change disagrees with base or target", () =>
      Effect.gen(function*() {
        const base = yield* (yield* Vfs.fromFixture({
          entries: [
            { kind: "directory", path: "/d" },
            { kind: "file", path: "/d/a", bytes: new Uint8Array([1]) },
            { kind: "hardLink", path: "/b", target: "/d/a" },
            { kind: "file", path: "/f", bytes: new Uint8Array([2]) }
          ]
        })).snapshot

        const target = yield* (yield* Vfs.fromFixture({
          entries: [
            { kind: "directory", path: "/d" },
            { kind: "file", path: "/d/a", bytes: new Uint8Array([1]) },
            { kind: "hardLink", path: "/b", target: "/d/a" },
            { kind: "file", path: "/f", bytes: new Uint8Array([3]), metadata: { mode: 0o600 } },
            { kind: "file", path: "/g", bytes: new Uint8Array([4]) }
          ]
        })).snapshot

        const encoded = yield* Schema.encodeEffect(Vfs.SnapshotDeltaFromBytes())(yield* Vfs.diffSnapshots(base, target))
        const source = document(encoded)
        const [updated, added] = source.changes
        assert.deepStrictEqual([updated?.path, updated?.differences, added?.path], [
          "L2Y=",
          ["content", "mode"],
          "L2c="
        ])
        const file = { _tag: "file", metadata: added!.node!.metadata!, content: { _tag: "Inline", bytes: "BA==" } }

        // A change the base does not bear out names itself; only a target identity the changes miss names `changes`.
        const cases: ReadonlyArray<readonly [string, ReadonlyArray<StoredChange>, string]> = [
          ["forged differences", [{ ...updated!, differences: ["content"] }, added!], "changes.0.differences"],
          [
            "addition at an existing path",
            [{ _tag: "Added", path: "L2Y=", kind: "file", node: updated!.node! }],
            "changes.0"
          ],
          [
            "removal of a missing path",
            [updated!, added!, { _tag: "Removed", path: "L3o=", kind: "file" }],
            "changes.2"
          ],
          ["removal of the wrong kind", [{ _tag: "Removed", path: "L2Q=", kind: "file" }], "changes.0"],
          ["one name of a hard-linked node removed", [{ _tag: "Removed", path: "L2I=", kind: "file" }], "changes.0"],
          [
            "a directory removed without its entries",
            [{ _tag: "Removed", path: "L2Q=", kind: "directory" }],
            "changes.0"
          ],
          [
            "an addition under a missing directory",
            [{ _tag: "Added", path: "L3gvZw==", kind: "file", node: file }],
            "parent"
          ],
          ["a change missing from the summary", [updated!], "changes"]
        ]

        for (const [label, changes, field] of cases) {
          const delta = yield* Schema.decodeEffect(Vfs.SnapshotDeltaFromBytes())(encodeDocument({ ...source, changes }))
          const error = yield* Effect.flip(Vfs.applySnapshotDelta(base, delta))
          assert.instanceOf(error, Vfs.VfsError, label)
          assert.deepStrictEqual([error.code, error.field], ["InvalidStructure", field], label)
        }

        const forged = yield* Schema.decodeEffect(Vfs.SnapshotDeltaFromBytes())(
          encodeDocument({ ...source, target: source.base })
        )

        const error = yield* Effect.flip(Vfs.inspectSnapshotDelta(base, forged))
        assert.instanceOf(error, Vfs.VfsError)
        assert.deepStrictEqual([error.code, error.field], ["InvalidStructure", "changes"])
      }))

    it.effect("should reject a change the base does not bear out even when the target identity matches its intended result", () =>
      Effect.gen(function*() {
        const snapshotOf = (entries: Vfs.Fixture["entries"]) =>
          Effect.flatMap(Vfs.fromFixture({ entries }), (volume) => volume.snapshot)

        const cases = [
          [
            // Without the check, `/d/a` would stay behind unreachable and the applied snapshot would still diff equal.
            "a directory removed without its entries",
            [{ kind: "directory", path: "/d" }, { kind: "file", path: "/d/a", bytes: new Uint8Array([1]) }],
            [],
            { _tag: "Removed", path: "L2Q=", kind: "directory" }
          ],
          [
            "one name of a hard-linked node removed",
            [{ kind: "file", path: "/a", bytes: new Uint8Array([1]) }, { kind: "hardLink", path: "/b", target: "/a" }],
            [{ kind: "file", path: "/a", bytes: new Uint8Array([1]) }],
            { _tag: "Removed", path: "L2I=", kind: "file" }
          ]
        ] as const

        for (const [label, baseEntries, targetEntries, change] of cases) {
          const base = yield* snapshotOf(baseEntries)

          const source = document(
            yield* Schema.encodeEffect(Vfs.SnapshotDeltaFromBytes())(
              yield* Vfs.diffSnapshots(base, yield* snapshotOf(targetEntries))
            )
          )

          const delta = yield* Schema.decodeEffect(Vfs.SnapshotDeltaFromBytes())(
            encodeDocument({ ...source, changes: [change] })
          )

          const error = yield* Effect.flip(Vfs.applySnapshotDelta(base, delta))
          assert.instanceOf(error, Vfs.VfsError, label)
          assert.deepStrictEqual([error.code, error.field], ["InvalidStructure", "changes.0"], label)
        }
      }))
  })
}

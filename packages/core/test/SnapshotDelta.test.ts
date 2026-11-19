import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect, Exit, Match, Option, Predicate, Schema } from "effect"
import type * as Digest from "effect/crypto/Digest"
import type * as SecureRandom from "effect/crypto/SecureRandom"
import * as Base64 from "effect/encoding/Base64"
import * as BytePath from "../src/BytePath.js"
import { Testing, VirtualFileSystem as Vfs } from "../src/index.js"
import { VfsError } from "../src/VfsError.js"
import { type Document, documentText, toLines } from "./support/lines.js"
import { entryNames, pathText, rawEntryNames, text } from "./support/text.js"

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
        run: (limits: Vfs.SnapshotDeltaLimits) => Effect.Effect<unknown, E, Digest.Digest | SecureRandom.SecureRandom>
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

      const refused = Effect.fnUntraced(
        function*<A, E>(attempt: Effect.Effect<A, E, Digest.Digest | SecureRandom.SecureRandom>, field: string) {
          const error = yield* Effect.flip(attempt)
          assert.instanceOf(error, Vfs.VfsError)
          assert.deepStrictEqual([error.code, error.field], ["LimitExceeded", field])
        }
      )

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

describe("delta fixtures", () => {
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
          encodeDocument({ ...source, changes: [{ ...source.changes[0], unexpected: true }] })
        ]

        for (const input of cases) assert.isDefined(yield* reject(input))

        const unsupported = yield* reject(encodeDocument({ ...source, version: 2 }))
        assert.strictEqual(unsupported.message, "Snapshot delta UnsupportedVersion")
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
          assert.strictEqual(error.message, `Snapshot delta InvalidEncoding at ${field}`)
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
})

describe("snapshot merges", () => {
  const encoder = new TextEncoder()

  const decoder = new TextDecoder()

  const text = (value: string) => encoder.encode(value)

  type Edit = (fs: Vfs.Caller) => Effect.Effect<unknown, Vfs.VfsError>

  const none: Edit = () => Effect.void

  const write = (path: string, value: string): Edit => (fs) =>
    fs.writeFile(path, text(value), { access: "write", truncate: true, create: "ifMissing" })

  const create = (path: string, value: string): Edit => (fs) =>
    fs.writeFile(path, text(value), { access: "write", create: "exclusive" })

  const remove = (path: string): Edit => (fs) => fs.remove(path, { recursive: true })

  const chmod = (path: string, mode: number): Edit => (fs) => fs.chmod(path, mode)

  const mkdir = (path: string): Edit => (fs) => fs.mkdir(path)

  const link = (from: string, to: string): Edit => (fs) => fs.link(from, to)

  const rename = (from: string, to: string): Edit => (fs) => fs.rename(from, to)

  const touch = (path: string, nanoseconds: bigint): Edit => (fs) =>
    fs.utimes(path, { access: { kind: "omit" }, modification: { kind: "value", nanoseconds } })

  const all = (...edits: ReadonlyArray<Edit>): Edit => (fs) => Effect.forEach(edits, (edit) => edit(fs))

  // The base every table row starts from: a directory with a child, loose files, a symlink and a hard-link pair.
  const fixture = Vfs.fromFixture({
    entries: [
      { kind: "directory", path: "/dir" },
      { kind: "file", path: "/dir/inner.txt", bytes: text("inner") },
      { kind: "file", path: "/shared.txt", bytes: text("v0") },
      { kind: "file", path: "/old.txt", bytes: text("old") },
      { kind: "file", path: "/r.txt", bytes: text("r") },
      { kind: "file", path: "/h", bytes: text("h") },
      { kind: "file", path: "/g1", bytes: text("g") },
      { kind: "hardLink", path: "/g2", target: "/g1" },
      { kind: "symlink", path: "/sym", target: "shared.txt" }
    ]
  })

  const pathText = (path: BytePath.BytePath) => Option.getOrElse(BytePath.toStringOption(path), () => "?")

  const render = Match.type<Vfs.SnapshotChange>().pipe(
    Match.tag(
      "Updated",
      (change) =>
        `Updated ${pathText(change.path)} ${change.beforeKind}->${change.afterKind} [${change.differences.join(",")}]`
    ),
    Match.orElse((change) => `${change._tag} ${pathText(change.path)}:${change.kind}`)
  )

  const sideText = Match.type<Vfs.MergeSideChange>().pipe(
    Match.tag("Unchanged", () => "Unchanged"),
    Match.tag("Updated", (side) => `Updated ${side.beforeKind}->${side.afterKind} [${side.differences.join(",")}]`),
    Match.orElse((side) => `${side._tag}:${side.kind}`)
  )

  const renderConflict = (conflict: Vfs.MergeConflict) =>
    `${pathText(conflict.path)} ${conflict.reason} ours=${sideText(conflict.ours)} theirs=${sideText(conflict.theirs)}`

  const resolutions = (entries: ReadonlyArray<readonly [string, Vfs.MergeTake]>) =>
    Effect.forEach(entries, ([path, take]) => BytePath.fromString(path).pipe(Effect.map((path) => ({ path, take }))))

  const deltaOf = Effect.fnUntraced(function*(base: Vfs.Snapshot, edit: Edit) {
    const overlay = yield* Vfs.makeOverlay(base)
    yield* edit(yield* overlay.caller())

    return yield* Vfs.diffSnapshots(base, (yield* overlay.capture()).snapshot)
  })

  const merge = Effect.fnUntraced(function*(
    ours: Edit,
    theirs: Edit,
    options?: Vfs.MergeOptions,
    source: Effect.Effect<Vfs.Volume, Vfs.VfsError, Digest.Digest | SecureRandom.SecureRandom> = fixture
  ) {
    const base = yield* (yield* source).snapshot

    const result = yield* Vfs.mergeSnapshotDeltas(
      base,
      yield* deltaOf(base, ours),
      yield* deltaOf(base, theirs),
      options
    )

    const changes = yield* Vfs.inspectSnapshotDelta(base, result.delta)
    const merged = yield* Vfs.fromSnapshot(yield* Vfs.applySnapshotDelta(base, result.delta))
    const reader = yield* merged.caller()

    return {
      base,
      result,
      changes: changes.map(render),
      conflicts: result.conflicts.map(renderConflict),
      read: (path: string) => reader.readFile(path).pipe(Effect.map((bytes) => decoder.decode(bytes))),
      stat: (path: string) => reader.stat(path)
    }
  })

  interface Row {
    readonly name: string
    readonly ours: Edit
    readonly theirs: Edit
    readonly changes: ReadonlyArray<string>
    readonly conflicts: ReadonlyArray<string>
  }

  // One row per paired change. The rendered change list is the merged delta as `inspectSnapshotDelta` reports it.
  const rows: ReadonlyArray<Row> = [
    {
      name: "disjoint edits are both taken",
      ours: write("/shared.txt", "ours"),
      theirs: create("/new.txt", "theirs"),
      changes: ["Added /new.txt:file", "Updated /shared.txt file->file [content]"],
      conflicts: []
    },
    {
      name: "the same edit on both sides is taken once",
      ours: write("/shared.txt", "same"),
      theirs: write("/shared.txt", "same"),
      changes: ["Updated /shared.txt file->file [content]"],
      conflicts: []
    },
    {
      name: "different content on both sides conflicts and keeps the base",
      ours: write("/shared.txt", "ours"),
      theirs: write("/shared.txt", "theirs"),
      changes: [],
      conflicts: ["/shared.txt BothChanged ours=Updated file->file [content] theirs=Updated file->file [content]"]
    },
    {
      name: "a mode change merges with a content change",
      ours: chmod("/shared.txt", 0o600),
      theirs: write("/shared.txt", "theirs"),
      changes: ["Updated /shared.txt file->file [content,mode]"],
      conflicts: []
    },
    {
      name: "the same mode on both sides merges",
      ours: chmod("/shared.txt", 0o600),
      theirs: chmod("/shared.txt", 0o600),
      changes: ["Updated /shared.txt file->file [mode]"],
      conflicts: []
    },
    {
      name: "different modes on both sides conflict",
      ours: chmod("/shared.txt", 0o600),
      theirs: chmod("/shared.txt", 0o640),
      changes: [],
      conflicts: ["/shared.txt BothChanged ours=Updated file->file [mode] theirs=Updated file->file [mode]"]
    },
    {
      name: "removing a file the other side edited conflicts",
      ours: remove("/old.txt"),
      theirs: write("/old.txt", "theirs"),
      changes: [],
      conflicts: ["/old.txt ChangedRemoved ours=Removed:file theirs=Updated file->file [content]"]
    },
    {
      name: "removing a file the other side only touched in time is taken",
      ours: remove("/old.txt"),
      theirs: touch("/old.txt", 5_000n),
      changes: ["Removed /old.txt:file"],
      conflicts: []
    },
    {
      name: "removing a directory the other side added under conflicts at the added path",
      ours: remove("/dir"),
      theirs: create("/dir/new.txt", "theirs"),
      changes: [],
      conflicts: ["/dir/new.txt ParentRemoved ours=Removed:directory theirs=Added:file"]
    },
    {
      name: "removing a directory the other side edited under conflicts at the edited path",
      ours: chmod("/dir/inner.txt", 0o600),
      theirs: remove("/dir"),
      changes: [],
      conflicts: ["/dir/inner.txt ParentRemoved ours=Updated file->file [mode] theirs=Removed:directory"]
    },
    {
      name: "removing a directory the other side only removed under is taken",
      ours: remove("/dir"),
      theirs: remove("/dir/inner.txt"),
      changes: ["Removed /dir:directory", "Removed /dir/inner.txt:file"],
      conflicts: []
    },
    {
      name: "removing a directory the other side changed in place conflicts at the directory",
      ours: remove("/dir"),
      theirs: chmod("/dir", 0o700),
      changes: [],
      conflicts: ["/dir ChangedRemoved ours=Removed:directory theirs=Updated directory->directory [mode]"]
    },
    {
      name: "a directory changed in place merges with a child added under it",
      ours: chmod("/dir", 0o700),
      theirs: create("/dir/new.txt", "theirs"),
      changes: ["Updated /dir directory->directory [mode]", "Added /dir/new.txt:file"],
      conflicts: []
    },
    {
      name: "a rename beside an edit of the old name adds the new name and conflicts at the old",
      ours: rename("/r.txt", "/moved.txt"),
      theirs: write("/r.txt", "theirs"),
      changes: ["Added /moved.txt:file"],
      conflicts: ["/r.txt ChangedRemoved ours=Removed:file theirs=Updated file->file [content]"]
    },
    {
      name: "two renames of one file to different names add both and remove the old",
      ours: rename("/r.txt", "/a.txt"),
      theirs: rename("/r.txt", "/b.txt"),
      changes: ["Added /a.txt:file", "Added /b.txt:file", "Removed /r.txt:file"],
      conflicts: []
    },
    {
      name: "the same addition on both sides is taken once",
      ours: create("/new.txt", "same"),
      theirs: create("/new.txt", "same"),
      changes: ["Added /new.txt:file"],
      conflicts: []
    },
    {
      name: "different additions at one path conflict",
      ours: create("/new.txt", "ours"),
      theirs: create("/new.txt", "theirs"),
      changes: [],
      conflicts: ["/new.txt BothAddedDifferent ours=Added:file theirs=Added:file"]
    },
    {
      name: "a file and a directory added at one path conflict and drop the directory's children",
      ours: create("/new", "ours"),
      theirs: all(mkdir("/new"), create("/new/child.txt", "theirs")),
      changes: [],
      conflicts: ["/new BothAddedDifferent ours=Added:file theirs=Added:directory"]
    },
    {
      name: "the same directory added on both sides merges its different children",
      ours: all(mkdir("/new"), create("/new/a.txt", "ours")),
      theirs: all(mkdir("/new"), create("/new/b.txt", "theirs")),
      changes: ["Added /new:directory", "Added /new/a.txt:file", "Added /new/b.txt:file"],
      conflicts: []
    },
    {
      name: "a kind change beside an edit conflicts",
      ours: all(remove("/old.txt"), mkdir("/old.txt")),
      theirs: write("/old.txt", "theirs"),
      changes: [],
      conflicts: ["/old.txt KindDiverged ours=Updated file->directory [kind,mode] theirs=Updated file->file [content]"]
    },
    {
      name: "the same kind change on both sides merges the children beneath",
      ours: all(remove("/old.txt"), mkdir("/old.txt"), create("/old.txt/a", "ours")),
      theirs: all(remove("/old.txt"), mkdir("/old.txt"), create("/old.txt/b", "theirs")),
      changes: ["Updated /old.txt file->directory [kind,mode]", "Added /old.txt/a:file", "Added /old.txt/b:file"],
      conflicts: []
    },
    {
      name: "a new hard link merges with an edit through the existing name",
      ours: link("/h", "/h2"),
      theirs: write("/h", "theirs"),
      changes: ["Updated /h file->file [content,hardLinks]", "Added /h2:file"],
      conflicts: []
    },
    {
      name: "unlinking one name merges with an edit through the other",
      ours: remove("/g2"),
      theirs: write("/g1", "theirs"),
      changes: ["Updated /g1 file->file [content,hardLinks]", "Removed /g2:file"],
      conflicts: []
    },
    {
      name: "membership changed on both sides conflicts across the whole group",
      ours: link("/g1", "/g3"),
      theirs: remove("/g2"),
      changes: [],
      conflicts: [
        "/g1 HardLinkGroupDiverged ours=Updated file->file [hardLinks] theirs=Updated file->file [hardLinks]",
        "/g2 HardLinkGroupDiverged ours=Updated file->file [hardLinks] theirs=Removed:file",
        "/g3 HardLinkGroupDiverged ours=Added:file theirs=Unchanged"
      ]
    },
    {
      name: "removing every name of a node the other side edited conflicts at each name",
      ours: all(remove("/g1"), remove("/g2")),
      theirs: write("/g2", "theirs"),
      changes: [],
      conflicts: [
        "/g1 ChangedRemoved ours=Removed:file theirs=Updated file->file [content]",
        "/g2 ChangedRemoved ours=Removed:file theirs=Updated file->file [content]"
      ]
    },
    {
      name: "linking a new name to a node the other side removed entirely conflicts at the new name",
      ours: remove("/h"),
      theirs: link("/h", "/h2"),
      changes: [],
      conflicts: ["/h2 ChangedRemoved ours=Unchanged theirs=Added:file"]
    },
    {
      name: "a symlink retargeted on one side merges with a mode change on the other",
      ours: (fs) => fs.remove("/sym").pipe(Effect.andThen(fs.symlink("old.txt", "/sym"))),
      theirs: chmod("/shared.txt", 0o600),
      changes: ["Updated /shared.txt file->file [mode]", "Updated /sym symlink->symlink [target]"],
      conflicts: []
    },
    {
      name: "nothing on either side merges to an empty delta",
      ours: none,
      theirs: none,
      changes: [],
      conflicts: []
    },
    {
      name: "a link to a node both sides added identically keeps the link",
      ours: create("/new.txt", "n"),
      theirs: all(create("/new.txt", "n"), link("/new.txt", "/zz")),
      changes: ["Added /new.txt:file", "Added /zz:file"],
      conflicts: []
    },
    {
      name: "a hard link and a fresh file with the same bytes added at one path conflict",
      ours: link("/h", "/new"),
      theirs: create("/new", "h"),
      changes: [],
      conflicts: ["/new BothAddedDifferent ours=Added:file theirs=Added:file"]
    },
    {
      name: "a conflict side that also touched timestamps reports only its real differences",
      ours: remove("/old.txt"),
      theirs: all(write("/old.txt", "t"), touch("/old.txt", 9_000n)),
      changes: [],
      conflicts: ["/old.txt ChangedRemoved ours=Removed:file theirs=Updated file->file [content]"]
    },
    {
      name: "removing one name and replacing the other's kind while the other side edits conflicts at both",
      ours: all(remove("/g1"), remove("/g2"), mkdir("/g2")),
      theirs: write("/g1", "theirs"),
      changes: [],
      conflicts: [
        "/g1 ChangedRemoved ours=Removed:file theirs=Updated file->file [content]",
        "/g2 KindDiverged ours=Updated file->directory [kind,hardLinks,mode] theirs=Updated file->file [content]"
      ]
    },
    {
      name: "the same kind change with different modes conflicts",
      ours: all(remove("/old.txt"), mkdir("/old.txt"), chmod("/old.txt", 0o700)),
      theirs: all(remove("/old.txt"), mkdir("/old.txt")),
      changes: [],
      conflicts: [
        "/old.txt KindDiverged ours=Updated file->directory [kind,mode] theirs=Updated file->directory [kind,mode]"
      ]
    },
    {
      name: "replacing a directory with a file while the other side edits beneath conflicts beneath",
      ours: all(remove("/dir"), create("/dir", "flat")),
      theirs: chmod("/dir/inner.txt", 0o600),
      changes: [],
      conflicts: [
        "/dir/inner.txt ParentRemoved ours=Updated directory->file [kind,mode] theirs=Updated file->file [mode]"
      ]
    },
    {
      name: "removing a directory the other side only touched in time beneath is taken",
      ours: remove("/dir"),
      theirs: touch("/dir/inner.txt", 9_000n),
      changes: ["Removed /dir:directory", "Removed /dir/inner.txt:file"],
      conflicts: []
    },
    {
      name: "different root modes conflict while children still merge",
      ours: all(chmod("/", 0o700), create("/ours.txt", "o")),
      theirs: all(chmod("/", 0o750), create("/theirs.txt", "t")),
      changes: ["Added /ours.txt:file", "Added /theirs.txt:file"],
      conflicts: ["/ BothChanged ours=Updated directory->directory [mode] theirs=Updated directory->directory [mode]"]
    },
    {
      name: "a split name beside an edit through the old name keeps both nodes",
      ours: all(remove("/g2"), create("/g2", "new")),
      theirs: write("/g1", "theirs"),
      changes: ["Updated /g1 file->file [content,hardLinks]", "Updated /g2 file->file [content,hardLinks]"],
      conflicts: []
    },
    {
      name: "a split name beside a mode change through the old name keeps the mode on the old node",
      ours: all(remove("/g2"), create("/g2", "new")),
      theirs: chmod("/g1", 0o600),
      changes: ["Updated /g1 file->file [hardLinks,mode]", "Updated /g2 file->file [content,hardLinks]"],
      conflicts: []
    },
    {
      name: "two sides that each unlink a different name of one node remove both",
      ours: remove("/g1"),
      theirs: remove("/g2"),
      changes: ["Removed /g1:file", "Removed /g2:file"],
      conflicts: []
    },
    {
      name: "removing every name while the other side unlinks one removes the node",
      ours: all(remove("/g1"), remove("/g2")),
      theirs: remove("/g2"),
      changes: ["Removed /g1:file", "Removed /g2:file"],
      conflicts: []
    },
    {
      name: "removing a directory the other side only touched in time is taken",
      ours: remove("/dir"),
      theirs: touch("/dir", 9_000n),
      changes: ["Removed /dir:directory", "Removed /dir/inner.txt:file"],
      conflicts: []
    },
    {
      name: "a node rewritten in place and given a name from another node merges with an edit of the other node",
      ours: all(remove("/g1"), remove("/h"), create("/h", "fresh"), link("/h", "/g1")),
      theirs: write("/g2", "theirs"),
      changes: [
        "Updated /g1 file->file [content,hardLinks]",
        "Updated /g2 file->file [content,hardLinks]",
        "Updated /h file->file [content,hardLinks]"
      ],
      conflicts: []
    }
  ]

  // A base with a three-name group, a link reaching into a directory, two loose files and a symlink.
  const linkFixture = Vfs.fromFixture({
    entries: [
      { kind: "directory", path: "/dir" },
      { kind: "file", path: "/dir/inner.txt", bytes: text("inner") },
      { kind: "file", path: "/h", bytes: text("h") },
      { kind: "hardLink", path: "/dir/l", target: "/h" },
      { kind: "file", path: "/a", bytes: text("a") },
      { kind: "file", path: "/b", bytes: text("b") },
      { kind: "file", path: "/t1", bytes: text("t") },
      { kind: "hardLink", path: "/t2", target: "/t1" },
      { kind: "hardLink", path: "/t3", target: "/t1" },
      { kind: "symlink", path: "/sym", target: "a" }
    ]
  })

  // `point(name, target)` removes `name` and links it to `target`'s node.
  const point = (name: string, target: string): Edit => all(remove(name), link(target, name))

  const linkRows: ReadonlyArray<Row> = [
    {
      name: "a new link whose name sorts first carries the other side's edit",
      ours: link("/h", "/0"),
      theirs: write("/h", "t"),
      changes: [
        "Added /0:file",
        "Updated /dir/l file->file [content,hardLinks]",
        "Updated /h file->file [content,hardLinks]"
      ],
      conflicts: []
    },
    {
      name: "a name pointed at another node beside an edit of that name conflicts without touching the target",
      ours: point("/a", "/b"),
      theirs: write("/a", "t"),
      changes: [],
      conflicts: ["/a ChangedRemoved ours=Updated file->file [content,hardLinks] theirs=Updated file->file [content]"]
    },
    {
      name: "two names pointed at each other's nodes conflict across the group",
      ours: point("/a", "/h"),
      theirs: point("/h", "/a"),
      changes: [],
      conflicts: [
        "/a HardLinkGroupDiverged ours=Updated file->file [content,hardLinks] theirs=Updated file->file [hardLinks]",
        "/dir/l HardLinkGroupDiverged ours=Updated file->file [hardLinks] theirs=Updated file->file [hardLinks]",
        "/h ChangedRemoved ours=Updated file->file [hardLinks] theirs=Updated file->file [content,hardLinks]"
      ]
    },
    {
      name: "one name pointed at two different nodes by the two sides conflicts at that name",
      ours: point("/a", "/b"),
      theirs: point("/a", "/h"),
      changes: [],
      conflicts: [
        "/a BothChanged ours=Updated file->file [content,hardLinks] theirs=Updated file->file [content,hardLinks]"
      ]
    },
    {
      name: "both sides removing a directory while one also removes a node's last name removes the node",
      ours: all(remove("/dir"), remove("/h")),
      theirs: remove("/dir"),
      changes: ["Removed /dir:directory", "Removed /dir/inner.txt:file", "Removed /dir/l:file", "Removed /h:file"],
      conflicts: []
    },
    {
      name: "a conflicted group under a removed directory keeps the directory",
      ours: remove("/dir"),
      theirs: all(remove("/dir/l"), link("/h", "/h2")),
      changes: [],
      conflicts: [
        "/dir/l HardLinkGroupDiverged ours=Removed:file theirs=Removed:file",
        "/h HardLinkGroupDiverged ours=Updated file->file [hardLinks] theirs=Updated file->file [hardLinks]",
        "/h2 HardLinkGroupDiverged ours=Unchanged theirs=Added:file"
      ]
    },
    {
      name: "the same link on both sides beside an edit through the old name merges",
      ours: all(link("/h", "/h2"), write("/h", "o")),
      theirs: link("/h", "/h2"),
      changes: [
        "Updated /dir/l file->file [content,hardLinks]",
        "Updated /h file->file [content,hardLinks]",
        "Added /h2:file"
      ],
      conflicts: []
    },
    {
      name: "a removed directory holding a linked name beside a new link is reported once per path",
      ours: remove("/dir"),
      theirs: link("/h", "/h2"),
      changes: [],
      conflicts: [
        "/dir/l HardLinkGroupDiverged ours=Removed:file theirs=Updated file->file [hardLinks]",
        "/h HardLinkGroupDiverged ours=Updated file->file [hardLinks] theirs=Updated file->file [hardLinks]",
        "/h2 HardLinkGroupDiverged ours=Unchanged theirs=Added:file"
      ]
    },
    {
      name: "unlinking two different names of a three-name node removes both",
      ours: remove("/t1"),
      theirs: remove("/t3"),
      changes: ["Removed /t1:file", "Updated /t2 file->file [hardLinks]", "Removed /t3:file"],
      conflicts: []
    },
    {
      name: "removing a directory with a linked name beside an edit of its other file conflicts and keeps the group",
      ours: remove("/dir"),
      theirs: chmod("/dir/inner.txt", 0o600),
      changes: [],
      conflicts: [
        "/dir/inner.txt ParentRemoved ours=Removed:directory theirs=Updated file->file [mode]",
        "/h HardLinkGroupDiverged ours=Updated file->file [hardLinks] theirs=Unchanged"
      ]
    },
    {
      name: "a new name linked to different nodes by the two sides conflicts and ties both nodes",
      ours: link("/a", "/c"),
      theirs: link("/b", "/c"),
      changes: [],
      conflicts: ["/c BothAddedDifferent ours=Added:file theirs=Added:file"]
    },
    {
      name: "a new name linked to different nodes holds back an edit of one of them",
      ours: all(link("/a", "/c"), write("/a", "x")),
      theirs: link("/b", "/c"),
      changes: [],
      conflicts: ["/c BothAddedDifferent ours=Added:file theirs=Added:file"]
    },
    {
      name: "replacing a directory with a link while the other side adds beneath it conflicts beneath",
      ours: all(remove("/dir"), link("/a", "/dir")),
      theirs: create("/dir/new.txt", "n"),
      changes: [],
      conflicts: [
        "/a HardLinkGroupDiverged ours=Updated file->file [hardLinks] theirs=Unchanged",
        "/dir/new.txt ParentRemoved ours=Updated directory->file [kind,hardLinks,mode] theirs=Added:file",
        "/h HardLinkGroupDiverged ours=Updated file->file [hardLinks] theirs=Unchanged"
      ]
    },
    {
      name: "a directory and a linked file moved to one new name conflict there",
      ours: rename("/dir", "/n"),
      theirs: rename("/t1", "/n"),
      changes: [],
      conflicts: [
        "/h HardLinkGroupDiverged ours=Updated file->file [hardLinks] theirs=Unchanged",
        "/n BothAddedDifferent ours=Added:directory theirs=Added:file",
        "/t2 HardLinkGroupDiverged ours=Unchanged theirs=Updated file->file [hardLinks]",
        "/t3 HardLinkGroupDiverged ours=Unchanged theirs=Updated file->file [hardLinks]"
      ]
    },
    {
      name: "the same join on both sides merges with an edit of the joined node on one side",
      ours: all(point("/t1", "/h"), write("/h", "x")),
      theirs: point("/t1", "/h"),
      changes: [
        "Updated /dir/l file->file [content,hardLinks]",
        "Updated /h file->file [content,hardLinks]",
        "Updated /t1 file->file [content,hardLinks]",
        "Updated /t2 file->file [hardLinks]",
        "Updated /t3 file->file [hardLinks]"
      ],
      conflicts: []
    },
    {
      name: "a join with an edit on one side merges with an unlink of the joined node on the other",
      ours: all(point("/t1", "/h"), write("/h", "x")),
      theirs: remove("/t2"),
      changes: [
        "Updated /dir/l file->file [content,hardLinks]",
        "Updated /h file->file [content,hardLinks]",
        "Updated /t1 file->file [content,hardLinks]",
        "Removed /t2:file",
        "Updated /t3 file->file [hardLinks]"
      ],
      conflicts: []
    },
    {
      name: "a withheld edit of a linked node outside a conflicted directory is reported",
      ours: remove("/dir"),
      theirs: all(write("/h", "x"), create("/dir/new.txt", "n"), write("/a", "a2")),
      changes: ["Updated /a file->file [content]"],
      conflicts: [
        "/dir/new.txt ParentRemoved ours=Removed:directory theirs=Added:file",
        "/h HardLinkGroupDiverged ours=Updated file->file [hardLinks] theirs=Updated file->file [content]"
      ]
    },
    {
      name: "removing a directory with a linked name beside a removal of the node's other name removes everything",
      ours: remove("/dir"),
      theirs: remove("/h"),
      changes: ["Removed /dir:directory", "Removed /dir/inner.txt:file", "Removed /dir/l:file", "Removed /h:file"],
      conflicts: []
    },
    {
      name: "a symlink linked under a new first name carries the other side's retarget",
      ours: link("/sym", "/0"),
      theirs: (fs) => fs.remove("/sym").pipe(Effect.andThen(fs.symlink("b", "/sym"))),
      changes: ["Added /0:symlink", "Updated /sym symlink->symlink [target,hardLinks]"],
      conflicts: []
    }
  ]

  it.layer(BunCrypto.layer)("snapshot delta merge", (it) => {
    for (const row of rows) {
      it.effect(`should ${row.name}`, () =>
        Effect.gen(function*() {
          const outcome = yield* merge(row.ours, row.theirs)

          assert.deepStrictEqual(outcome.changes, row.changes)
          assert.deepStrictEqual(outcome.conflicts, row.conflicts)
        }))
    }

    it.effect("should leave the base bytes at a conflicted path and apply the other changes", () =>
      Effect.gen(function*() {
        const outcome = yield* merge(
          all(write("/shared.txt", "ours"), create("/ours.txt", "o")),
          all(write("/shared.txt", "theirs"), create("/theirs.txt", "t"))
        )

        assert.strictEqual(yield* outcome.read("/shared.txt"), "v0")
        assert.strictEqual(yield* outcome.read("/ours.txt"), "o")
        assert.strictEqual(yield* outcome.read("/theirs.txt"), "t")
      }))

    it.effect("should write the edited bytes through every name of a merged hard-link group", () =>
      Effect.gen(function*() {
        const outcome = yield* merge(link("/h", "/h2"), write("/h", "theirs"))

        assert.strictEqual(yield* outcome.read("/h"), "theirs")
        assert.strictEqual(yield* outcome.read("/h2"), "theirs")
        assert.strictEqual((yield* outcome.stat("/h2")).nlink, 2)
      }))

    it.effect("should take the later modification time when both sides changed it", () =>
      Effect.gen(function*() {
        for (const [ours, theirs] of [[100_000n, 200_000n], [200_000n, 100_000n]] as const) {
          const outcome = yield* merge(touch("/shared.txt", ours), touch("/shared.txt", theirs))

          assert.deepStrictEqual(outcome.conflicts, [])
          assert.strictEqual((yield* outcome.stat("/shared.txt")).mtimeNs, 200_000n)
        }
      }))

    it.effect("should take the side a resolution names at a conflicted path", () =>
      Effect.gen(function*() {
        const resolve = Effect.fnUntraced(function*(take: Vfs.MergeTake) {
          return yield* merge(write("/shared.txt", "ours"), write("/shared.txt", "theirs"), {
            resolutions: yield* resolutions([["/shared.txt", take]])
          })
        })

        const ours = yield* resolve("ours")
        const theirs = yield* resolve("theirs")
        const base = yield* resolve("base")

        assert.deepStrictEqual(ours.conflicts, [])
        assert.strictEqual(yield* ours.read("/shared.txt"), "ours")
        assert.strictEqual(yield* theirs.read("/shared.txt"), "theirs")
        assert.deepStrictEqual(base.conflicts, [])
        assert.strictEqual(yield* base.read("/shared.txt"), "v0")
      }))

    it.effect("should take a removed directory's subtree as a whole when its conflict is resolved", () =>
      Effect.gen(function*() {
        const resolve = Effect.fnUntraced(function*(take: Vfs.MergeTake) {
          return yield* merge(remove("/dir"), all(create("/dir/new.txt", "theirs"), create("/other.txt", "t")), {
            resolutions: yield* resolutions([["/dir/new.txt", take]])
          })
        })

        const ours = yield* resolve("ours")
        const theirs = yield* resolve("theirs")

        assert.deepStrictEqual(ours.changes, [
          "Removed /dir:directory",
          "Removed /dir/inner.txt:file",
          "Added /other.txt:file"
        ])
        assert.deepStrictEqual(theirs.changes, ["Added /dir/new.txt:file", "Added /other.txt:file"])
        assert.strictEqual(yield* theirs.read("/dir/inner.txt"), "inner")
      }))

    it.effect("should reject a resolution for a path that is not in conflict", () =>
      Effect.gen(function*() {
        const failure = yield* Effect.flip(
          merge(write("/shared.txt", "ours"), create("/new.txt", "t"), {
            resolutions: yield* resolutions([["/new.txt", "ours"]])
          })
        )

        assert.instanceOf(failure, Vfs.VfsError)
        assert.deepStrictEqual([failure.code, failure.field], ["InvalidArgument", "resolutions"])
      }))

    it.effect("should reject resolutions that split one hard-link group between sides", () =>
      Effect.gen(function*() {
        const partial = yield* Effect.flip(
          merge(link("/g1", "/g3"), remove("/g2"), {
            resolutions: yield* resolutions([["/g1", "ours"]])
          })
        )

        const split = yield* Effect.flip(
          merge(link("/g1", "/g3"), remove("/g2"), {
            resolutions: yield* resolutions([["/g1", "ours"], ["/g2", "theirs"], ["/g3", "ours"]])
          })
        )

        assert.instanceOf(partial, Vfs.VfsError)
        assert.instanceOf(split, Vfs.VfsError)
        assert.deepStrictEqual([partial.code, split.code], ["InvalidArgument", "InvalidArgument"])
      }))

    it.effect("should take one side of a hard-link group when every path resolves the same way", () =>
      Effect.gen(function*() {
        const outcome = yield* merge(link("/g1", "/g3"), remove("/g2"), {
          resolutions: yield* resolutions([["/g1", "theirs"], ["/g2", "theirs"], ["/g3", "theirs"]])
        })

        assert.deepStrictEqual(outcome.changes, ["Updated /g1 file->file [hardLinks]", "Removed /g2:file"])
      }))

    for (const row of linkRows) {
      it.effect(`should ${row.name}`, () =>
        Effect.gen(function*() {
          const outcome = yield* merge(row.ours, row.theirs, undefined, linkFixture)

          assert.deepStrictEqual(outcome.changes, row.changes)
          assert.deepStrictEqual(outcome.conflicts, row.conflicts)
        }))
    }

    it.effect("should write the other side's bytes through a new first-sorting link name", () =>
      Effect.gen(function*() {
        const outcome = yield* merge(link("/h", "/0"), write("/h", "t"), undefined, linkFixture)

        assert.strictEqual(yield* outcome.read("/0"), "t")
        assert.strictEqual(yield* outcome.read("/dir/l"), "t")
        assert.strictEqual((yield* outcome.stat("/0")).nlink, 3)
      }))

    it.effect("should leave a target node alone when a name pointed at it is in conflict", () =>
      Effect.gen(function*() {
        const outcome = yield* merge(point("/a", "/b"), write("/a", "t"), undefined, linkFixture)

        assert.strictEqual(yield* outcome.read("/a"), "a")
        assert.strictEqual(yield* outcome.read("/b"), "b")
        assert.strictEqual((yield* outcome.stat("/b")).nlink, 1)
      }))

    it.effect("should keep a linked node intact when the directory above one name is in conflict", () =>
      Effect.gen(function*() {
        const resolve = Effect.fnUntraced(function*(take: Vfs.MergeTake | undefined) {
          return yield* merge(remove("/dir"), chmod("/dir/inner.txt", 0o600), {
            resolutions: take === undefined ? [] : yield* resolutions([["/dir/inner.txt", take], ["/h", take]])
          }, linkFixture)
        })

        const open = yield* resolve(undefined)
        const base = yield* resolve("base")
        const theirs = yield* resolve("theirs")
        const ours = yield* resolve("ours")

        assert.strictEqual((yield* open.stat("/h")).nlink, 2)
        assert.deepStrictEqual(base.changes, [])
        assert.strictEqual((yield* base.stat("/h")).nlink, 2)
        assert.deepStrictEqual(theirs.changes, ["Updated /dir/inner.txt file->file [mode]"])
        assert.strictEqual((yield* theirs.stat("/h")).nlink, 2)
        assert.deepStrictEqual(ours.changes, [
          "Removed /dir:directory",
          "Removed /dir/inner.txt:file",
          "Removed /dir/l:file",
          "Updated /h file->file [hardLinks]"
        ])
        assert.strictEqual((yield* ours.stat("/h")).nlink, 1)
      }))

    it.effect("should take one side of a diverged group whole, including a replaced name", () =>
      Effect.gen(function*() {
        const resolve = Effect.fnUntraced(function*(take: Vfs.MergeTake) {
          return yield* merge(all(remove("/t1"), mkdir("/t1")), link("/t2", "/t4"), {
            resolutions: yield* resolutions([["/t1", take], ["/t2", take], ["/t3", take], ["/t4", take]])
          }, linkFixture)
        })

        const ours = yield* resolve("ours")
        const theirs = yield* resolve("theirs")

        assert.deepStrictEqual(ours.conflicts, [])
        assert.deepStrictEqual(ours.changes, [
          "Updated /t1 file->directory [kind,hardLinks,mode]",
          "Updated /t2 file->file [hardLinks]",
          "Updated /t3 file->file [hardLinks]"
        ])
        assert.strictEqual((yield* ours.stat("/t2")).nlink, 2)
        assert.deepStrictEqual(theirs.changes, [
          "Updated /t1 file->file [hardLinks]",
          "Updated /t2 file->file [hardLinks]",
          "Updated /t3 file->file [hardLinks]",
          "Added /t4:file"
        ])
        assert.strictEqual((yield* theirs.stat("/t4")).nlink, 4)
      }))

    it.effect("should keep a timestamp-only change beside the other side's metadata change", () =>
      Effect.gen(function*() {
        const outcome = yield* merge(chmod("/shared.txt", 0o600), touch("/shared.txt", 7_000n))

        assert.deepStrictEqual(outcome.conflicts, [])
        const stat = yield* outcome.stat("/shared.txt")
        assert.strictEqual(stat.mtimeNs, 7_000n)
        assert.strictEqual(stat.mode & 0o777, 0o600)
      }))

    it.effect("should reject malformed options with InvalidArgument", () =>
      Effect.gen(function*() {
        const base = yield* (yield* fixture).snapshot
        const delta = yield* deltaOf(base, none)

        // Options arrive from a boundary as untyped data here, so the operation's own decoding has to reject them.
        // SAFETY: the parsed value is deliberately outside the option type; the test asserts the rejection.
        const malformed = (yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
          "{\"resolutions\":{}}"
        )) as Vfs.MergeOptions

        const bogus = yield* Effect.flip(Vfs.mergeSnapshotDeltas(base, delta, delta, malformed))

        assert.instanceOf(bogus, Vfs.VfsError)
        assert.deepStrictEqual([bogus.code, bogus.field], ["InvalidArgument", "resolutions"])
      }))

    it.effect("should reject a delta from another base", () =>
      Effect.gen(function*() {
        const base = yield* (yield* fixture).snapshot
        const otherBase = yield* (yield* Vfs.fromFixture({ entries: [] })).snapshot

        const failure = yield* Effect.flip(
          Vfs.mergeSnapshotDeltas(base, yield* deltaOf(base, none), yield* deltaOf(otherBase, none))
        )

        assert.instanceOf(failure, Vfs.VfsError)
        assert.deepStrictEqual([failure.code, failure.operation], ["BaseMismatch", "mergeSnapshotDeltas"])
      }))
  })

  // Property tests draw two edit scripts over a small set of paths and check the merge laws on their deltas.
  const Path = Schema.Literals(["/0", "/a", "/b", "/dir", "/dir/x", "/dir/y", "/g1", "/g2", "/g3", "/s"])

  const Step = Schema.Union([
    Schema.TaggedStruct("Write", { path: Path, value: Schema.Literals(["one", "two"]) }),
    Schema.TaggedStruct("Remove", { path: Path }),
    Schema.TaggedStruct("Chmod", { path: Path, mode: Schema.Literals([0o600, 0o644, 0o755]) }),
    Schema.TaggedStruct("Mkdir", { path: Path }),
    Schema.TaggedStruct("Link", { from: Path, to: Path }),
    Schema.TaggedStruct("Rename", { from: Path, to: Path }),
    Schema.TaggedStruct("Symlink", { path: Path, target: Schema.Literals(["a", "dir"]) }),
    Schema.TaggedStruct("Touch", { path: Path, nanoseconds: Schema.Literals([1_000n, 2_000n]) })
  ])

  type Step = typeof Step.Type

  const Script = Schema.Array(Step).check(Schema.isMaxLength(7))

  // Each law runs with a fixed seed so CI is reproducible; a failure prints the replay token of its exact case.
  // Vitest applies one deadline to all 150 filesystem scenarios in a law.
  const law = (seed: number) => ({ timeout: 30_000, arbitrary: { runs: 150, seed } })

  const propertyFixture = Vfs.fromFixture({
    entries: [
      { kind: "file", path: "/a", bytes: text("a") },
      { kind: "file", path: "/b", bytes: text("b") },
      { kind: "directory", path: "/dir" },
      { kind: "file", path: "/dir/x", bytes: text("x") },
      { kind: "hardLink", path: "/dir/y", target: "/b" },
      { kind: "file", path: "/g1", bytes: text("g") },
      { kind: "hardLink", path: "/g2", target: "/g1" },
      { kind: "hardLink", path: "/g3", target: "/g1" },
      { kind: "symlink", path: "/s", target: "a" }
    ]
  })

  // Steps that do not apply to the current tree are skipped, so every script yields a valid side.
  const stepEdit = Match.type<Step>().pipe(
    Match.tag("Write", (step) => write(step.path, step.value)),
    Match.tag("Remove", (step) => remove(step.path)),
    Match.tag("Chmod", (step) => chmod(step.path, step.mode)),
    Match.tag("Mkdir", (step) => mkdir(step.path)),
    Match.tag("Link", (step) => link(step.from, step.to)),
    Match.tag("Rename", (step) => rename(step.from, step.to)),
    Match.tag("Symlink", (step): Edit => (fs) => fs.symlink(step.target, step.path)),
    Match.tag("Touch", (step) => touch(step.path, step.nanoseconds)),
    Match.exhaustive
  )

  const run = (script: ReadonlyArray<Step>): Edit => (fs) =>
    Effect.forEach(script, (step) => Effect.ignore(stepEdit(step)(fs)))

  const encodeDelta = Schema.encodeEffect(Vfs.SnapshotDeltaFromBytes())

  const sameDelta = Effect.fnUntraced(function*(left: Vfs.SnapshotDelta, right: Vfs.SnapshotDelta) {
    assert.deepStrictEqual(yield* encodeDelta(left), yield* encodeDelta(right))
  })

  const swapped = (conflict: Vfs.MergeConflict): Vfs.MergeConflict => ({
    path: conflict.path,
    reason: conflict.reason,
    ours: conflict.theirs,
    theirs: conflict.ours
  })

  it.layer(BunCrypto.layer)("snapshot delta merge laws", (it) => {
    const inspected = (base: Vfs.Snapshot, delta: Vfs.SnapshotDelta) =>
      Vfs.inspectSnapshotDelta(base, delta, { includeTimestamps: true }).pipe(
        Effect.map((changes) => new Map(changes.map((change) => [pathText(change.path), render(change)])))
      )

    it.effect.prop(
      "should return a delta unchanged when merged with an empty delta",
      { script: Script },
      ({ script }) =>
        Effect.gen(function*() {
          const base = yield* (yield* propertyFixture).snapshot
          const delta = yield* deltaOf(base, run(script))
          const empty = yield* deltaOf(base, none)
          const left = yield* Vfs.mergeSnapshotDeltas(base, delta, empty)
          const right = yield* Vfs.mergeSnapshotDeltas(base, empty, delta)

          assert.deepStrictEqual(left.conflicts, [])
          assert.deepStrictEqual(right.conflicts, [])
          yield* sameDelta(left.delta, delta)
          yield* sameDelta(right.delta, delta)
        }),
      law(1)
    )

    it.effect.prop(
      "should return a delta unchanged when merged with itself",
      { script: Script },
      ({ script }) =>
        Effect.gen(function*() {
          const base = yield* (yield* propertyFixture).snapshot
          const delta = yield* deltaOf(base, run(script))
          const result = yield* Vfs.mergeSnapshotDeltas(base, delta, delta)

          assert.deepStrictEqual(result.conflicts, [])
          yield* sameDelta(result.delta, delta)
        }),
      law(2)
    )

    it.effect.prop(
      "should mirror the result when the sides are swapped",
      { ours: Script, theirs: Script },
      ({ ours, theirs }) =>
        Effect.gen(function*() {
          const base = yield* (yield* propertyFixture).snapshot
          const o = yield* deltaOf(base, run(ours))
          const t = yield* deltaOf(base, run(theirs))
          const forward = yield* Vfs.mergeSnapshotDeltas(base, o, t)
          const backward = yield* Vfs.mergeSnapshotDeltas(base, t, o)

          yield* sameDelta(forward.delta, backward.delta)
          assert.deepStrictEqual(
            forward.conflicts.map(renderConflict),
            backward.conflicts.map(swapped).map(renderConflict)
          )
        }),
      law(3)
    )

    it.effect.prop(
      "should apply cleanly and report nothing once every conflict takes one side",
      { ours: Script, theirs: Script },
      ({ ours, theirs }) =>
        Effect.gen(function*() {
          const base = yield* (yield* propertyFixture).snapshot
          const o = yield* deltaOf(base, run(ours))
          const t = yield* deltaOf(base, run(theirs))
          const first = yield* Vfs.mergeSnapshotDeltas(base, o, t)

          for (const take of ["ours", "theirs", "base"] as const) {
            const resolutions = first.conflicts.map((conflict) => ({ path: conflict.path, take }))
            const second = yield* Vfs.mergeSnapshotDeltas(base, o, t, { resolutions })

            assert.deepStrictEqual(second.conflicts, [])
            yield* Vfs.applySnapshotDelta(base, second.delta)
          }
        }),
      law(4)
    )

    it.effect.prop(
      "should take a path only one side changed exactly as that side left it when nothing conflicts",
      { ours: Script, theirs: Script },
      ({ ours, theirs }) =>
        Effect.gen(function*() {
          const base = yield* (yield* propertyFixture).snapshot
          const o = yield* deltaOf(base, run(ours))
          const t = yield* deltaOf(base, run(theirs))
          const result = yield* Vfs.mergeSnapshotDeltas(base, o, t)

          if (result.conflicts.length > 0) return
          const oursChanges = yield* inspected(base, o)
          const theirsChanges = yield* inspected(base, t)
          const merged = yield* inspected(base, result.delta)

          // A hard-linked name's group can still change through the other side, so compare names outside any group.
          const grouped = new Set(["/b", "/dir/y", "/g1", "/g2", "/g3"])

          for (const [path, change] of oursChanges) {
            if (!theirsChanges.has(path) && !grouped.has(path)) assert.strictEqual(merged.get(path), change, path)
          }

          for (const [path, change] of theirsChanges) {
            if (!oursChanges.has(path) && !grouped.has(path)) assert.strictEqual(merged.get(path), change, path)
          }
        }),
      law(5)
    )

    it.effect.prop(
      "should leave every conflicted path at base and write nothing outside both sides' paths",
      { ours: Script, theirs: Script },
      ({ ours, theirs }) =>
        Effect.gen(function*() {
          const base = yield* (yield* propertyFixture).snapshot
          const o = yield* deltaOf(base, run(ours))
          const t = yield* deltaOf(base, run(theirs))
          const result = yield* Vfs.mergeSnapshotDeltas(base, o, t)
          const union = new Set([...(yield* inspected(base, o)).keys(), ...(yield* inspected(base, t)).keys()])
          const merged = yield* inspected(base, result.delta)

          for (const conflict of result.conflicts) {
            assert.isFalse(merged.has(pathText(conflict.path)), pathText(conflict.path))
          }

          for (const path of merged.keys()) assert.isTrue(union.has(path), path)
        }),
      law(6)
    )
  })
})

it.layer(BunCrypto.layer)("overlay capture merges", (it) => {
  const encoder = new TextEncoder()

  const fixture = Vfs.fromFixture({
    entries: [
      { kind: "directory", path: "/dir" },
      { kind: "file", path: "/source", bytes: encoder.encode("base") },
      { kind: "file", path: "/other", bytes: encoder.encode("untouched") },
      { kind: "symlink", path: "/sym", target: "source" }
    ]
  })

  const both = Effect.gen(function*() {
    const base = yield* (yield* fixture).snapshot
    const ours = yield* Vfs.makeOverlay(base)
    const theirs = yield* Vfs.makeOverlay(base)

    return { base, ours, theirs, left: yield* ours.caller(), right: yield* theirs.caller() }
  })

  const write = (fs: Vfs.Caller, path: string | BytePath.BytePath, bytes: string) =>
    fs.writeFile(path, encoder.encode(bytes), { access: "write", truncate: true, create: "ifMissing" })

  const merge = Effect.fnUntraced(function*(
    base: Vfs.Snapshot,
    ours: Vfs.OverlayVolume,
    theirs: Vfs.OverlayVolume,
    options?: Vfs.OverlayMergeOptions
  ) {
    return yield* Vfs.mergeOverlayCaptures(
      base,
      yield* Vfs.captureOverlayForMerge(ours),
      yield* Vfs.captureOverlayForMerge(theirs),
      options
    )
  })

  const renameConflict = (result: Vfs.OverlayMergeResult) => {
    const conflict = result.conflicts[0]

    if (conflict?.kind !== "rename") throw new Error("Expected a rename conflict")

    return conflict
  }

  const apply = Effect.fnUntraced(function*(base: Vfs.Snapshot, delta: Vfs.SnapshotDelta) {
    const volume = yield* Vfs.fromSnapshot(yield* Vfs.applySnapshotDelta(base, delta))

    return yield* volume.caller()
  })

  const readText = (caller: Vfs.Caller, path: string | BytePath.BytePath) => Effect.map(caller.readFile(path), text)

  const isVfsError = Schema.is(VfsError)

  const mergeFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.flip(effect).pipe(Effect.map((error) => {
      if (!isVfsError(error)) throw new Error("Expected a VFS failure", { cause: error })

      return error
    }))

  it.effect("should follow an edit to the renamed path when merging an earlier capture", () =>
    Effect.gen(function*() {
      const { base, ours, theirs, left, right } = yield* both
      yield* left.rename("/source", "/dir/moved")
      yield* left.chmod("/dir/moved", 0o600)
      yield* write(right, "/source", "edit")
      const capture = yield* Vfs.captureOverlayForMerge(ours)
      const edited = yield* Vfs.captureOverlayForMerge(theirs)
      yield* write(left, "/dir/moved", "later")

      const equivalent = yield* Vfs.decodeSnapshot(yield* Vfs.encodeSnapshot(base), {
        maxEncodedBytes: ByteSize.kilobytes(10),
        maxDecodedBytes: ByteSize.kilobytes(10),
        maxEntries: 10,
        maxRecords: 10
      })

      const result = yield* Vfs.mergeOverlayCaptures(equivalent, capture, edited)
      const mirrored = yield* Vfs.mergeOverlayCaptures(equivalent, edited, capture)
      const fs = yield* apply(equivalent, result.delta)

      assert.deepStrictEqual(result.conflicts, [])
      assert.strictEqual(yield* readText(fs, "/dir/moved"), "edit")
      assert.strictEqual((yield* fs.stat("/dir/moved")).mode, 0o600)
      assert.deepStrictEqual(
        yield* Vfs.inspectSnapshotDelta(equivalent, result.delta),
        yield* Vfs.inspectSnapshotDelta(equivalent, mirrored.delta)
      )
      assert.strictEqual((yield* Effect.flip(fs.stat("/source"))).code, "NotFound")
    }))

  it.effect("should preserve the base paths until a divergent move is resolved as a group", () =>
    Effect.gen(function*() {
      const { base, ours, theirs, left, right } = yield* both
      yield* left.rename("/source", "/a")
      yield* right.rename("/source", "/b")
      yield* write(right, "/b", "right")
      yield* write(left, "/other", "clean")
      const oursCapture = yield* Vfs.captureOverlayForMerge(ours)
      const theirsCapture = yield* Vfs.captureOverlayForMerge(theirs)
      const result = yield* Vfs.mergeOverlayCaptures(base, oursCapture, theirsCapture)
      assert.lengthOf(result.conflicts, 1)
      const { detail: conflict, key } = renameConflict(result)
      assert.strictEqual(conflict.reason, "RenameDiverged")
      assert.strictEqual(yield* pathText(conflict.path), "/source")
      assert.strictEqual(yield* pathText(conflict.ours.destination), "/a")
      assert.strictEqual(yield* pathText(conflict.theirs.destination), "/b")
      assert.strictEqual(conflict.theirs.changes._tag, "Updated")
      const fs = yield* apply(base, result.delta)
      assert.strictEqual(yield* readText(fs, "/source"), "base")
      assert.strictEqual(yield* readText(fs, "/other"), "clean")
      assert.strictEqual((yield* Effect.flip(fs.stat("/a"))).code, "NotFound")
      assert.strictEqual((yield* Effect.flip(fs.stat("/b"))).code, "NotFound")

      for (const take of ["ours", "theirs", "base"] as const) {
        const chosen = yield* Vfs.mergeOverlayCaptures(base, oursCapture, theirsCapture, {
          resolutions: [{ key, take }]
        })

        const fs = yield* apply(base, chosen.delta)
        assert.deepStrictEqual(chosen.conflicts, [])
        const path = take === "ours" ? "/a" : take === "theirs" ? "/b" : "/source"
        assert.strictEqual(yield* readText(fs, path), take === "theirs" ? "right" : "base")
        assert.strictEqual(yield* readText(fs, "/other"), "clean")
        assert.deepStrictEqual(
          entryNames(yield* fs.readDirectory("/")),
          ["dir", "other", "sym", path.slice(1)].sort()
        )
      }

      const choice = { key, take: "base" } as const
      assert.strictEqual(
        (yield* mergeFailure(
          Vfs.mergeOverlayCaptures(base, oursCapture, theirsCapture, { resolutions: [choice, choice] })
        )).code,
        "InvalidArgument"
      )
      assert.strictEqual(
        (yield* mergeFailure(Vfs.mergeOverlayCaptures(base, oursCapture, theirsCapture, {
          resolutions: [{ ...choice, key: "unknown" }]
        }))).code,
        "InvalidArgument"
      )
    }))

  it.effect("should take a removal against a clean move and conflict against an edited move", () =>
    Effect.gen(function*() {
      const { base, ours, theirs, left, right } = yield* both
      yield* left.rename("/source", "/moved")
      yield* right.remove("/source")
      const clean = yield* merge(base, ours, theirs)
      assert.deepStrictEqual(clean.conflicts, [])
      const fs = yield* apply(base, clean.delta)
      assert.strictEqual((yield* Effect.flip(fs.stat("/source"))).code, "NotFound")
      assert.strictEqual((yield* Effect.flip(fs.stat("/moved"))).code, "NotFound")

      yield* write(left, "/moved", "edit")
      const edited = yield* merge(base, ours, theirs)
      assert.strictEqual(renameConflict(edited).detail.reason, "ChangedRemoved")
      assert.strictEqual(yield* pathText(renameConflict(edited).detail.path), "/moved")
    }))

  it.effect("should combine source edits before comparing an independent addition", () =>
    Effect.gen(function*() {
      const { base, ours, theirs, left, right } = yield* both
      yield* left.rename("/source", "/moved")
      yield* write(right, "/source", "combined")
      yield* write(right, "/moved", "different")
      const oursCapture = yield* Vfs.captureOverlayForMerge(ours)
      const theirsCapture = yield* Vfs.captureOverlayForMerge(theirs)
      const disputed = yield* Vfs.mergeOverlayCaptures(base, oursCapture, theirsCapture)
      const { detail: conflict, key } = renameConflict(disputed)
      assert.strictEqual(conflict.reason, "BothAddedDifferent")
      assert.isTrue(conflict.theirs.independentAddition)

      const chosen = yield* Vfs.mergeOverlayCaptures(base, oursCapture, theirsCapture, {
        resolutions: [{ key, take: "theirs" }]
      })

      const fs = yield* apply(base, chosen.delta)
      assert.strictEqual(yield* readText(fs, "/source"), "combined")
      assert.strictEqual(yield* readText(fs, "/moved"), "different")

      yield* write(right, "/moved", "combined")
      const combined = yield* merge(base, ours, theirs)
      assert.deepStrictEqual(combined.conflicts, [])
      const merged = yield* apply(base, combined.delta)
      assert.strictEqual(yield* readText(merged, "/moved"), "combined")
      assert.strictEqual((yield* mergeFailure(merged.stat("/source"))).code, "NotFound")

      yield* write(left, "/moved", "left")
      const changed = yield* merge(base, ours, theirs)
      assert.strictEqual(renameConflict(changed).detail.reason, "BothChanged")
    }))

  it.effect("should reject fabricated captures and captures from a foreign base", () =>
    Effect.gen(function*() {
      const { base, ours, theirs } = yield* both
      const retained = yield* Vfs.captureOverlayForMerge(ours)
      const publicCapture: object = yield* theirs.capture()
      // SAFETY: Intentionally forge an input to exercise the runtime registry check.
      const fake = publicCapture as typeof retained
      assert.strictEqual(
        (yield* mergeFailure(Vfs.mergeOverlayCaptures(base, retained, fake))).code,
        "InvalidArgument"
      )
      assert.strictEqual((yield* Effect.flip(Vfs.captureOverlayForMerge({ ...ours }))).code, "InvalidArgument")

      const empty = yield* (yield* Vfs.make()).snapshot
      const foreign = yield* Vfs.captureOverlayForMerge(yield* Vfs.makeOverlay(empty))
      assert.strictEqual(
        (yield* mergeFailure(Vfs.mergeOverlayCaptures(base, retained, foreign))).code,
        "BaseMismatch"
      )
      assert.strictEqual(
        (yield* mergeFailure(Vfs.mergeOverlayCaptures(base, foreign, retained))).code,
        "BaseMismatch"
      )
    }))

  it.effect("should reject a destination directory together with its children", () =>
    Effect.gen(function*() {
      const { base, ours, theirs, left, right } = yield* both

      yield* left.rename("/source", "/moved")
      yield* right.mkdir("/moved")
      yield* write(right, "/moved/child", "directory collision")
      const collision = yield* mergeFailure(merge(base, ours, theirs))
      assert.strictEqual(collision.code, "InvalidStructure")
      assert.strictEqual(collision.field, "renameDestination")
      assert.strictEqual(yield* pathText(collision.path), "/moved")
    }))

  it.effect("should merge moves to the same byte path and preserve identity and idempotence", () =>
    Effect.gen(function*() {
      const { base, ours, theirs, left, right } = yield* both
      const untouched = yield* merge(base, ours, theirs)
      assert.deepStrictEqual(yield* Vfs.inspectSnapshotDelta(base, untouched.delta), [])
      const raw = yield* BytePath.fromBytes(Uint8Array.of(47, 255))
      yield* left.rename("/source", raw)
      const oneSided = yield* merge(base, ours, theirs)
      const moved = yield* Vfs.diffSnapshots(base, (yield* ours.capture()).snapshot)
      assert.deepStrictEqual(oneSided.conflicts, [])
      assert.deepStrictEqual(
        yield* Vfs.inspectSnapshotDelta(base, oneSided.delta),
        yield* Vfs.inspectSnapshotDelta(base, moved)
      )

      yield* right.rename("/source", raw)
      yield* write(left, raw, "edited")
      yield* right.chmod(raw, 0o640)
      const combined = yield* merge(base, ours, theirs)
      const same = yield* merge(base, ours, ours)
      const reader = yield* apply(base, combined.delta)
      assert.deepStrictEqual(combined.conflicts, [])
      assert.strictEqual(yield* readText(reader, raw), "edited")
      assert.strictEqual((yield* reader.stat(raw)).mode, 0o640)
      const standalone = yield* Vfs.diffSnapshots(base, (yield* ours.capture()).snapshot)
      assert.deepStrictEqual(
        yield* Vfs.inspectSnapshotDelta(base, same.delta),
        yield* Vfs.inspectSnapshotDelta(base, standalone)
      )
    }))

  it.effect("should treat an equal-byte replacement as an addition and removal", () =>
    Effect.gen(function*() {
      const { base, ours, theirs, left, right } = yield* both
      yield* left.remove("/source")
      yield* write(left, "/moved", "base")
      yield* write(right, "/source", "edit")

      const result = yield* merge(base, ours, theirs)

      assert.lengthOf(result.conflicts, 1)
      const conflict = result.conflicts[0]

      if (conflict?.kind !== "path") throw new Error("Expected an ordinary path conflict")

      assert.strictEqual(conflict.details[0]?.reason, "ChangedRemoved")
      const fs = yield* apply(base, result.delta)
      assert.strictEqual(yield* readText(fs, "/source"), "base")
      assert.strictEqual(yield* readText(fs, "/moved"), "base")
    }))

  it.effect("should resolve ordinary path conflicts alongside rename groups", () =>
    Effect.gen(function*() {
      const { base, ours, theirs, left, right } = yield* both
      yield* left.rename("/source", "/a")
      yield* right.rename("/source", "/b")
      yield* write(left, "/other", "left")
      yield* write(right, "/other", "right")
      const oursCapture = yield* Vfs.captureOverlayForMerge(ours)
      const theirsCapture = yield* Vfs.captureOverlayForMerge(theirs)
      const pending = yield* Vfs.mergeOverlayCaptures(base, oursCapture, theirsCapture)
      const rename = renameConflict(pending)
      const ordinary = pending.conflicts.find((conflict) => conflict.kind === "path")

      if (ordinary === undefined) throw new Error("Expected an ordinary path conflict")

      const first = { key: rename.key, take: "ours" } as const
      const partial = yield* Vfs.mergeOverlayCaptures(base, oursCapture, theirsCapture, { resolutions: [first] })
      assert.deepStrictEqual(partial.conflicts.map((conflict) => conflict.key), [ordinary.key])

      const chosen = yield* Vfs.mergeOverlayCaptures(base, oursCapture, theirsCapture, {
        resolutions: [first, { key: ordinary.key, take: "theirs" }]
      })

      const fs = yield* apply(base, chosen.delta)
      assert.deepStrictEqual(chosen.conflicts, [])
      assert.strictEqual(yield* readText(fs, "/a"), "base")
      assert.strictEqual(yield* readText(fs, "/other"), "right")

      const otherCapture = yield* Vfs.captureOverlayForMerge(theirs)
      assert.strictEqual(
        (yield* mergeFailure(Vfs.mergeOverlayCaptures(base, oursCapture, otherCapture, { resolutions: [first] })))
          .code,
        "InvalidArgument"
      )
    }))

  it.effect.each(
    [
      ["directory move", (fs: Vfs.Caller) => fs.rename("/dir", "/moved"), "renameLineage"],
      ["symlink move", (fs: Vfs.Caller) => fs.rename("/sym", "/moved"), "renameLineage"],
      ["hard-linked file move", (fs: Vfs.Caller) =>
        Effect.gen(function*() {
          yield* fs.link("/source", "/alias")
          yield* fs.rename("/source", "/moved")
        }), "renameLineage"],
      ["occupied destination", (fs: Vfs.Caller) => fs.rename("/source", "/other"), "renameOverlap"],
      ["swap", (fs: Vfs.Caller) =>
        Effect.gen(function*() {
          yield* fs.rename("/source", "/temp")
          yield* fs.rename("/other", "/source")
          yield* fs.rename("/temp", "/other")
        }), "renameOverlap"]
    ] as const
  )("should reject an unsupported move when the scenario is %s", ([, edit, field]) =>
    Effect.gen(function*() {
      const { base, ours, theirs, left } = yield* both
      yield* edit(left)

      const error = yield* mergeFailure(merge(base, ours, theirs))

      assert.strictEqual(error.code, "InvalidStructure")
      assert.strictEqual(error.field, field)
    }))

  it.effect("should reject moves from different sources to the same destination", () =>
    Effect.gen(function*() {
      const { base, ours, theirs, left, right } = yield* both
      yield* left.rename("/source", "/moved")
      yield* right.rename("/other", "/moved")

      const error = yield* mergeFailure(merge(base, ours, theirs))

      assert.strictEqual(error.code, "InvalidStructure")
      assert.strictEqual(error.field, "renameOverlap")
      assert.strictEqual(yield* pathText(error.path), "/moved")
    }))

  it.effect("should reject a move when the other side replaces its destination parent", () =>
    Effect.gen(function*() {
      const { base, ours, theirs, left, right } = yield* both
      yield* left.rename("/source", "/dir/moved")
      yield* right.remove("/dir")
      yield* right.mkdir("/dir")

      const error = yield* mergeFailure(merge(base, ours, theirs))

      assert.strictEqual(error.code, "InvalidStructure")
      assert.strictEqual(error.field, "renameParent")
    }))

  it.effect("should enforce the path count limit when unresolved moves produce an empty delta", () =>
    Effect.gen(function*() {
      const count = 12
      const sources = Array.from({ length: count }, (_, index) => "/s" + index)

      const volume = yield* Vfs.fromFixture({
        entries: sources.map((path) => ({ kind: "file" as const, path, bytes: encoder.encode("base") }))
      })

      const base = yield* volume.snapshot
      const ours = yield* Vfs.makeOverlay(base)
      const theirs = yield* Vfs.makeOverlay(base)
      const left = yield* ours.caller()
      const right = yield* theirs.caller()

      for (const [index, source] of sources.entries()) {
        yield* left.rename(source, "/a" + index)
        yield* right.rename(source, "/b" + index)
      }

      const exact = count * 3

      const at = yield* merge(base, ours, theirs, {
        limits: { ...Vfs.SnapshotDeltaLimits.default, maxEntries: exact }
      })

      assert.strictEqual(at.conflicts.length, count)
      assert.deepStrictEqual(yield* Vfs.inspectSnapshotDelta(base, at.delta), [])

      const over = yield* mergeFailure(
        merge(base, ours, theirs, { limits: { ...Vfs.SnapshotDeltaLimits.default, maxEntries: exact - 1 } })
      )

      assert.strictEqual(over.code, "LimitExceeded")
      assert.strictEqual(over.field, "renamePaths")
    }))

  it.effect("should enforce the byte limit for paths in rename groups", () =>
    Effect.gen(function*() {
      const { base, ours, theirs, left, right } = yield* both
      const a = "/" + "é".repeat(40)
      const b = "/" + "b".repeat(80)
      yield* left.rename("/source", a)
      yield* right.rename("/source", b)
      const exact = encoder.encode(a).length + encoder.encode(b).length + encoder.encode("/source").length

      const at = yield* merge(base, ours, theirs, {
        limits: { ...Vfs.SnapshotDeltaLimits.default, maxDecodedDeltaBytes: ByteSize.bytes(exact) }
      })

      assert.strictEqual(renameConflict(at).detail.reason, "RenameDiverged")

      const fail = yield* mergeFailure(
        merge(base, ours, theirs, {
          limits: { ...Vfs.SnapshotDeltaLimits.default, maxDecodedDeltaBytes: ByteSize.bytes(exact - 1) }
        })
      )

      assert.strictEqual(fail.code, "LimitExceeded")
      assert.strictEqual(fail.field, "renamePathBytes")
    }))
})

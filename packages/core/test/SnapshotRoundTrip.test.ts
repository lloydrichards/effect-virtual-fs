import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect, Encoding, Layer, Predicate, Schema, Stream } from "effect"
import { BytePath, LiveVolume, VirtualFileSystem as Vfs } from "../src/index.js"
import { documentText, toLines } from "./support/lines.js"
import { entryNames } from "./support/text.js"

const LIMITS: Vfs.DecodeLimits = {
  maxEncodedBytes: ByteSize.megabytes(1),
  maxRecords: 1_000,
  maxEntries: 1_000,
  maxDecodedBytes: ByteSize.megabytes(1)
}

const encoder = new TextEncoder()

const bytes = (value: string) => encoder.encode(value)

// A name that is not UTF-8, so no string path can reach it.
const RAW_NAME = new Uint8Array([0xff, 0x41])

// Longer than one base64 encoding chunk, with a length that needs padding.
const LARGE: Uint8Array<ArrayBuffer> = Uint8Array.from({ length: 24_577 }, (_, index) => index % 251)

const EXTREME_NS = 10n ** 127n

const METADATA = { uid: 0, gid: 0, mode: 0o755, atimeNs: "0", mtimeNs: "0", ctimeNs: "0", birthtimeNs: "0" }

const ROOT_NODE = { _tag: "directory", ino: 1, parent: 1, name: "", metadata: METADATA }

const base64 = (value: string) => Encoding.encodeBase64(bytes(value))

// A snapshot's nodes as JSON values, each keeping every field it was written with.
const SampleTree = Schema.fromJsonString(Schema.Struct({
  format: Schema.String,
  version: Schema.Finite,
  nodes: Schema.Array(Schema.Record(Schema.String, Schema.Unknown))
}))

const snapshotOf = (nodes: ReadonlyArray<object>) => toLines({ format: "effect-vfs", version: 1, nodes })

// POSIX NAME_MAX, the longest name a directory holds.
const NAME_MAX = 255

const rootNames = (caller: Vfs.Caller) => Effect.map(caller.readDirectory("/"), entryNames)

// Every node kind, an empty and a multi-chunk file, byte names and targets, a hard link across directories, the
// setuid, setgid and sticky bits, and timestamps at both ends of the range.
const fixture = (raw: BytePath.BytePath, rawTarget: BytePath.BytePath): Vfs.Fixture => ({
  rootMetadata: { mode: 0o1777, uid: 3, gid: 4 },
  entries: [
    { kind: "directory", path: "/a", metadata: { mode: 0o2750, atimeNs: -EXTREME_NS, birthtimeNs: 5n } },
    { kind: "directory", path: "/a/b" },
    { kind: "file", path: "/a/b/large", bytes: LARGE, metadata: { mode: 0o4755, mtimeNs: EXTREME_NS } },
    { kind: "file", path: "/empty", bytes: new Uint8Array() },
    { kind: "hardLink", path: "/linked", target: "/a/b/large" },
    { kind: "file", path: raw, bytes: RAW_NAME, metadata: { uid: 70_000, gid: 80_000 } },
    { kind: "symlink", path: "/a/raw-target", target: rawTarget },
    { kind: "symlink", path: "/a/empty-target", target: "" }
  ]
})

const describeTree = Effect.fnUntraced(function*(caller: Vfs.Caller) {
  const walked = yield* Stream.runCollect(caller.walk("/"))

  const objects: Array<{ path: Uint8Array; reference: Vfs.ObjectReference }> = [
    { path: bytes("/"), reference: yield* caller.root }
  ]

  for (const entry of walked) objects.push({ path: yield* BytePath.toBytes(entry.path), reference: entry.reference })
  const paths = new Map<bigint, Array<string>>()
  const rows: Array<{ key: string; ino: bigint; metadata: object; payload: string | undefined }> = []

  for (const { path, reference } of objects) {
    const { ino, revision: _revision, ...metadata } = yield* caller.stat(reference)
    const key = Encoding.encodeHex(path)
    paths.set(ino, [...(paths.get(ino) ?? []), key])

    const payload = metadata.kind === "file"
      ? yield* caller.readFile(reference)
      : metadata.kind === "symlink"
      ? yield* caller.readLink(reference)
      : undefined

    rows.push({ key, ino, metadata, payload: payload === undefined ? undefined : Encoding.encodeHex(payload) })
  }

  // Inode numbers are not portable, so each row names the paths that share its object instead.
  return rows
    .map(({ ino, ...row }) => ({ ...row, links: [...(paths.get(ino) ?? [])].sort() }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
})

const inodes = Effect.fnUntraced(function*(caller: Vfs.Caller) {
  const walked = yield* Stream.runCollect(caller.walk("/"))
  const found = [(yield* caller.stat("/")).ino]

  for (const entry of walked) found.push((yield* caller.stat(entry.reference)).ino)

  return found
})

// A live image store that keeps the last committed image in memory.
const memoryImageStore = () => {
  let image: Uint8Array | undefined

  return Layer.succeed(
    LiveVolume.LiveImageStore,
    LiveVolume.LiveImageStore.of({
      loadOrCreate: (initial) => Effect.succeed(image ?? initial),
      commit: (candidate) =>
        Effect.sync(() => {
          image = candidate

          return "committed" as const
        })
    })
  )
}

const richVolume = Effect.gen(function*() {
  const raw = yield* Vfs.pathFromBytes(new Uint8Array([47, ...RAW_NAME]))
  const rawTarget = yield* Vfs.pathFromBytes(new Uint8Array([0xfe, 47, 0x80]))
  const volume = yield* Vfs.fromFixture(fixture(raw, rawTarget))
  const caller = yield* volume.caller()

  // Changes made after construction: a rename, a second hard link, and an open file that no name reaches, which a
  // snapshot must leave out.
  yield* caller.rename("/empty", "/a/moved")
  yield* caller.link("/a/b/large", "/a/second")
  const open = yield* caller.open("/gone", { access: "write", create: "exclusive" })
  yield* open.write(new Uint8Array([1, 2, 3]))
  yield* caller.unlink("/gone")

  return { volume, caller }
})

describe("snapshot round trips", () => {
  it.effect("re-encodes decoded bytes identically and restores the captured tree", () =>
    Effect.gen(function*() {
      const { volume, caller } = yield* richVolume
      const expected = yield* describeTree(caller)
      const snapshot = yield* volume.snapshot
      const encoded = yield* Vfs.encodeSnapshot(snapshot)
      const decoded = yield* Vfs.decodeSnapshot(encoded, LIMITS)

      assert.deepStrictEqual(yield* Vfs.encodeSnapshot(decoded), encoded)
      assert.deepStrictEqual(yield* describeTree(yield* (yield* Vfs.fromSnapshot(snapshot)).caller()), expected)
      assert.deepStrictEqual(yield* describeTree(yield* (yield* Vfs.fromSnapshot(decoded)).caller()), expected)
      assert.deepStrictEqual(yield* describeTree(yield* (yield* Vfs.makeOverlay(decoded)).caller()), expected)
    }))

  it.effect("encodes a fixture's volume the same however often it is built", () =>
    Effect.gen(function*() {
      const raw = yield* Vfs.pathFromBytes(new Uint8Array([47, ...RAW_NAME]))
      const rawTarget = yield* Vfs.pathFromBytes(new Uint8Array([0xfe, 47, 0x80]))
      const first = yield* Vfs.encodeSnapshot(yield* (yield* Vfs.fromFixture(fixture(raw, rawTarget))).snapshot)
      const second = yield* Vfs.encodeSnapshot(yield* (yield* Vfs.fromFixture(fixture(raw, rawTarget))).snapshot)

      assert.deepStrictEqual(second, first)
      assert.deepStrictEqual(yield* Vfs.encodeSnapshot(yield* Vfs.decodeSnapshot(first, LIMITS)), first)
    }))

  it.effect("allocates fresh inodes after restoring a snapshot with gaps in its inode numbers", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const caller = yield* volume.caller()

      for (let index = 0; index < 80; index++) {
        yield* caller.writeFile(`/f${index}`, new Uint8Array([index]), { access: "write", create: "exclusive" })
      }

      for (let index = 0; index < 80; index += 3) yield* caller.unlink(`/f${index}`)
      const snapshot = yield* Vfs.decodeSnapshot(yield* Vfs.encodeSnapshot(yield* volume.snapshot), LIMITS)

      for (const restored of [yield* Vfs.fromSnapshot(snapshot), yield* Vfs.makeOverlay(snapshot)]) {
        const fs = yield* restored.caller()

        for (let index = 0; index < 80; index++) {
          yield* fs.writeFile(`/g${index}`, new Uint8Array([index]), { access: "write", create: "exclusive" })
        }

        const found = yield* inodes(fs)
        assert.strictEqual(new Set(found).size, found.length)
        assert.strictEqual(found.length, 1 + 80 - 27 + 80)
        assert.deepStrictEqual(yield* fs.readFile("/f79"), new Uint8Array([79]))
      }
    }))

  it.effect("reopens a live image with the tree and allocator it committed", () => {
    const store = memoryImageStore()

    const options = {
      maxImageBytes: ByteSize.megabytes(1),
      volume: {
        maxEntries: 100,
        maxBytes: ByteSize.kilobytes(256),
        maxFileBytes: ByteSize.kilobytes(64),
        maxPathBytes: ByteSize.bytes(1024)
      }
    }

    return Effect.gen(function*() {
      const expected = yield* Effect.scoped(Effect.gen(function*() {
        const caller = yield* (yield* LiveVolume.open(options)).caller()
        const raw = yield* Vfs.pathFromBytes(new Uint8Array([47, ...RAW_NAME]))
        yield* caller.mkdir("/a", { mode: 0o2750 })
        yield* caller.writeFile("/a/large", LARGE, { access: "write", create: "exclusive" })
        yield* caller.link("/a/large", "/linked")
        yield* caller.symlink(yield* Vfs.pathFromBytes(new Uint8Array([0xfe, 47, 0x80])), raw)
        yield* caller.writeFile("/doomed", new Uint8Array([1]), { access: "write", create: "exclusive" })
        yield* caller.unlink("/doomed")
        yield* caller.chmod("/a/large", 0o4755)

        return { tree: yield* describeTree(caller), inodes: yield* inodes(caller) }
      }))

      yield* Effect.scoped(Effect.gen(function*() {
        const caller = yield* (yield* LiveVolume.open(options)).caller()
        assert.deepStrictEqual(yield* describeTree(caller), expected.tree)
        assert.deepStrictEqual(yield* inodes(caller), expected.inodes)

        const created = yield* caller.mkdir("/new")
        const ino = (yield* caller.stat(created.reference)).ino
        assert.isFalse(expected.inodes.includes(ino))
        assert.isTrue(ino > expected.inodes.reduce((max, next) => (next > max ? next : max)))
      }))
    }).pipe(Effect.provide(store))
  })

  it.effect("lists a restored volume's directories in the byte order of their names, however it was restored", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const caller = yield* volume.caller()
      yield* caller.writeFile("/zeta", new Uint8Array([1]), { access: "write", create: "exclusive" })
      yield* caller.writeFile("/alpha", new Uint8Array([2]), { access: "write", create: "exclusive" })
      assert.deepStrictEqual(yield* rootNames(caller), ["zeta", "alpha"])

      const snapshot = yield* volume.snapshot
      const decoded = yield* Vfs.decodeSnapshot(yield* Vfs.encodeSnapshot(snapshot), LIMITS)

      for (
        const restored of [
          yield* Vfs.fromSnapshot(snapshot),
          yield* Vfs.fromSnapshot(decoded),
          yield* Vfs.makeOverlay(snapshot),
          yield* Vfs.makeOverlay(decoded)
        ]
      ) assert.deepStrictEqual(yield* rootNames(yield* restored.caller()), ["alpha", "zeta"])
    }))

  it.effect("starts a restored volume's revisions afresh, however it was restored", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const caller = yield* volume.caller()
      yield* caller.writeFile("/f", new Uint8Array([1]), { access: "write", create: "exclusive" })
      yield* caller.writeFile("/f", new Uint8Array([2]), { access: "write", truncate: true })
      yield* caller.writeFile("/f", new Uint8Array([3]), { access: "write", truncate: true })
      const sourceRevision = (yield* caller.stat("/f")).revision

      const snapshot = yield* volume.snapshot
      const decoded = yield* Vfs.decodeSnapshot(yield* Vfs.encodeSnapshot(snapshot), LIMITS)

      // The revisions of "/" and "/f" on restore, then after the same two mutations.
      const progress = Effect.fnUntraced(function*(restored: Vfs.Volume) {
        const fs = yield* restored.caller()

        const revisions = () =>
          Effect.all([fs.stat("/"), fs.stat("/f")]).pipe(Effect.map((stats) => stats.map((stat) => stat.revision)))

        const restoredRevisions = yield* revisions()

        yield* fs.writeFile("/f", new Uint8Array([4]), { access: "write", truncate: true })
        yield* fs.writeFile("/g", new Uint8Array([5]), { access: "write", create: "exclusive" })

        return [restoredRevisions, yield* revisions(), (yield* fs.stat("/g")).revision]
      })

      const fromDecoded = yield* progress(yield* Vfs.fromSnapshot(decoded))
      assert.deepStrictEqual(fromDecoded[0], [1n, 1n])

      for (
        const restored of [
          yield* Vfs.fromSnapshot(snapshot),
          yield* Vfs.makeOverlay(snapshot),
          yield* Vfs.makeOverlay(decoded)
        ]
      ) assert.deepStrictEqual(yield* progress(restored), fromDecoded)

      assert.strictEqual((yield* caller.stat("/f")).revision, sourceRevision)
    }))

  it.effect("lists a reopened live image's directories in the byte order of their names", () => {
    const options = {
      maxImageBytes: ByteSize.megabytes(1),
      volume: {
        maxEntries: 100,
        maxBytes: ByteSize.kilobytes(256),
        maxFileBytes: ByteSize.kilobytes(64),
        maxPathBytes: ByteSize.bytes(1024)
      }
    }

    return Effect.gen(function*() {
      yield* Effect.scoped(Effect.gen(function*() {
        const caller = yield* (yield* LiveVolume.open(options)).caller()
        yield* caller.writeFile("/zeta", new Uint8Array([1]), { access: "write", create: "exclusive" })
        yield* caller.writeFile("/alpha", new Uint8Array([2]), { access: "write", create: "exclusive" })
        assert.deepStrictEqual(yield* rootNames(caller), ["zeta", "alpha"])
      }))

      yield* Effect.scoped(Effect.gen(function*() {
        const caller = yield* (yield* LiveVolume.open(options)).caller()
        assert.deepStrictEqual(yield* rootNames(caller), ["alpha", "zeta"])
      }))
    }).pipe(Effect.provide(memoryImageStore()))
  })
})

describe("snapshot decoding rejects hostile input", () => {
  const sample = Effect.gen(function*() {
    const volume = yield* Vfs.fromFixture({
      entries: [
        { kind: "directory", path: "/d" },
        { kind: "file", path: "/d/f", bytes: new Uint8Array([1, 2, 3]) },
        { kind: "hardLink", path: "/alias", target: "/d/f" },
        { kind: "symlink", path: "/s", target: "d/f" }
      ]
    })

    return yield* Vfs.encodeSnapshot(yield* volume.snapshot)
  })

  // Four objects and four names; the names and payloads decode to d, f, alias, s, three bytes and d/f.
  const EXACT = {
    ...LIMITS,
    maxRecords: 4,
    maxEntries: 4,
    maxDecodedBytes: ByteSize.bytes(1 + 1 + 5 + 1 + 3 + 3)
  }

  const failure = (input: Uint8Array, limits: Vfs.DecodeLimits = LIMITS) =>
    Effect.map(Effect.flip(Vfs.decodeSnapshot(input, limits)), (error) => [error.code, error.field] as const)

  // The header line holds the format and the version and nothing else.
  const PREFIX = "{\"format\":\"effect-vfs\",\"version\":1"

  const withPrefix = (input: Uint8Array, prefix: string) => {
    const text = new TextDecoder().decode(input)
    assert.isTrue(text.startsWith(PREFIX))

    return encoder.encode(prefix + text.slice(PREFIX.length))
  }

  it.effect("accepts a snapshot at exactly its budgets and refuses one unit less of each", () =>
    Effect.gen(function*() {
      const encoded = yield* sample

      yield* Vfs.decodeSnapshot(encoded, { ...EXACT, maxEncodedBytes: ByteSize.bytes(encoded.length) })

      for (
        const limits of [
          { ...EXACT, maxEncodedBytes: ByteSize.bytes(encoded.length - 1) },
          { ...EXACT, maxRecords: 3 },
          { ...EXACT, maxEntries: 3 },
          { ...EXACT, maxDecodedBytes: ByteSize.bytes(13) }
        ]
      ) assert.strictEqual((yield* failure(encoded, limits))[0], "LimitExceeded")

      assert.deepStrictEqual(
        yield* failure(encoded, { ...EXACT, maxEncodedBytes: ByteSize.bytes(encoded.length - 1) }),
        ["LimitExceeded", "encodedBytes"]
      )
    }))

  it.effect("refuses input that is not a detached UTF-8 JSON document", () =>
    Effect.gen(function*() {
      const encoded = yield* sample
      const shared = new Uint8Array(new SharedArrayBuffer(encoded.length))
      shared.set(encoded)

      // @ts-expect-error exercises the runtime guard against a value outside the public Uint8Array contract
      assert.strictEqual((yield* Effect.flip(Vfs.decodeSnapshot(Array.from(encoded), LIMITS))).code, "InvalidEncoding")

      for (
        const input of [
          shared,
          new Uint8Array([255]),
          encoded.subarray(0, encoded.length - 1),
          bytes("{"),
          new Uint8Array([...bytes("{\"format\":\"effect-vfs\",\"version\":1,\"x\":\""), 0xe2, 0x82])
        ]
      ) assert.strictEqual((yield* failure(input))[0], "InvalidEncoding")
    }))

  it.effect("refuses other formats and versions before reading the document", () =>
    Effect.gen(function*() {
      const encoded = yield* sample

      for (const version of ["0", "2", "\"1\"", "null"]) {
        assert.deepStrictEqual(
          yield* failure(withPrefix(encoded, `{"format":"effect-vfs","version":${version}`)),
          ["UnsupportedVersion", "version"]
        )
      }

      for (const value of ["[]", "null", "\"effect-vfs\"", "{\"format\":\"effect-vfs-live\",\"version\":1}"]) {
        assert.strictEqual((yield* failure(bytes(`${value}\n`)))[0], "InvalidStructure")
      }
    }))

  it.effect("refuses unknown fields on the document", () =>
    Effect.gen(function*() {
      const encoded = yield* sample

      assert.deepStrictEqual(
        yield* failure(withPrefix(encoded, `${PREFIX},"extra":true`)),
        ["InvalidStructure", "document"]
      )
    }))

  it.effect("counts every budget before it checks the graph or decodes a name or target", () =>
    Effect.gen(function*() {
      // Each tree breaks a budget and a graph rule; the budget is what refuses it.
      const brokenLink = snapshotOf([
        ROOT_NODE,
        { _tag: "directory", ino: 2, parent: 1, name: base64("d"), metadata: METADATA },
        {
          _tag: "file",
          ino: 3,
          links: [{ parent: 9, name: base64("f") }],
          content: { _tag: "Inline", bytes: "AQ==" },
          metadata: METADATA
        }
      ])

      const repeatedName = snapshotOf([
        ROOT_NODE,
        { _tag: "directory", ino: 2, parent: 1, name: base64("a"), metadata: METADATA },
        { _tag: "directory", ino: 3, parent: 1, name: base64("a"), metadata: METADATA }
      ])

      // 300 kB of NUL bytes as a symbolic link's target.
      const nulTarget = snapshotOf([
        ROOT_NODE,
        {
          _tag: "symlink",
          ino: 2,
          links: [{ parent: 1, name: base64("s") }],
          target: "A".repeat(400_000),
          metadata: METADATA
        }
      ])

      assert.deepStrictEqual(yield* failure(brokenLink, { ...LIMITS, maxRecords: 2 }), ["LimitExceeded", "records"])
      assert.deepStrictEqual(yield* failure(repeatedName, { ...LIMITS, maxEntries: 1 }), ["LimitExceeded", "entries"])

      assert.deepStrictEqual(
        yield* failure(nulTarget, { ...LIMITS, maxDecodedBytes: ByteSize.bytes(10) }),
        ["LimitExceeded", "bytes"]
      )

      // Within the budgets, the same trees fail the graph rule they break.
      assert.deepStrictEqual(yield* failure(brokenLink), ["InvalidStructure", "nodes.2.links.0.parent"])
      assert.deepStrictEqual(yield* failure(repeatedName), ["InvalidStructure", "nodes.2.name"])
      assert.deepStrictEqual(yield* failure(nulTarget), ["InvalidStructure", "nodes.1.target"])
    }))

  it.effect("names the directory or symbolic link below the root that breaks a graph rule", () =>
    Effect.gen(function*() {
      const original = yield* Schema.decodeEffect(SampleTree)(documentText(yield* sample))
      const directory = original.nodes.findIndex((node, index) => index > 0 && Predicate.isTagged(node, "directory"))
      const symlink = original.nodes.findIndex(Predicate.isTagged("symlink"))

      const mutations: Array<
        readonly [number, { readonly name?: string; readonly parent?: number; readonly target?: string }, string]
      > = [
        [symlink, { target: base64("a\0b") }, `nodes.${symlink}.target`],
        [directory, { name: base64(".") }, `nodes.${directory}.name`],
        [directory, { name: base64("d/e") }, `nodes.${directory}.name`],
        [directory, { parent: 99 }, `nodes.${directory}.parent`]
      ]

      for (const [index, edit, field] of mutations) {
        const nodes = original.nodes.map((node, at) => (at === index ? { ...node, ...edit } : node))
        assert.deepStrictEqual(yield* failure(toLines({ ...original, nodes })), ["InvalidStructure", field])
      }
    }))

  it.effect("holds snapshots and fixtures to one name rule, admitting NAME_MAX bytes and no more", () =>
    Effect.gen(function*() {
      const file = (name: string) =>
        snapshotOf([
          ROOT_NODE,
          {
            _tag: "file",
            ino: 2,
            links: [{ parent: 1, name: base64(name) }],
            content: { _tag: "Inline", bytes: "AQ==" },
            metadata: METADATA
          }
        ])

      const longest = "a".repeat(NAME_MAX)
      const restored = yield* Vfs.fromSnapshot(yield* Vfs.decodeSnapshot(file(longest), LIMITS))
      assert.deepStrictEqual(yield* rootNames(yield* restored.caller()), [longest])
      assert.deepStrictEqual(yield* failure(file(`${longest}a`)), ["InvalidStructure", "nodes.1.links.0.name"])

      const fixture = (name: string) =>
        Vfs.fromFixture({ entries: [{ kind: "file", path: `/${name}`, bytes: new Uint8Array([1]) }] })

      assert.deepStrictEqual(yield* rootNames(yield* (yield* fixture(longest)).caller()), [longest])

      const refused = yield* Effect.flip(fixture(`${longest}a`))
      assert.deepStrictEqual([refused.code, refused.field], ["InvalidStructure", "path"])
    }))
})

describe("restored inode numbers", () => {
  // A root holding a directory `d` and a file `d/f`, at the inode numbers given.
  const tree = (directory: number, file: number) =>
    toLines({
      format: "effect-vfs",
      version: 1,
      nodes: [
        { _tag: "directory", ino: 1, parent: 1, name: "", metadata: METADATA },
        { _tag: "directory", ino: directory, parent: 1, name: "ZA==", metadata: METADATA },
        {
          _tag: "file",
          ino: file,
          links: [{ parent: directory, name: "Zg==" }],
          content: { _tag: "Inline", bytes: "AQ==" },
          metadata: METADATA
        }
      ].sort((a, b) => a.ino - b.ino)
    })

  it.effect("restores inode numbers past the inode table's first levels and allocates above them", () =>
    Effect.gen(function*() {
      // 2^35 and beyond need a table deep enough that its indexing can no longer use 32-bit shifts.
      for (const [directory, file] of [[2 ** 35, 2 ** 35 + 33], [2 ** 40 + 7, 3], [2 ** 52, 2 ** 52 + 1]] as const) {
        const encoded = tree(directory, file)
        const snapshot = yield* Vfs.decodeSnapshot(encoded, LIMITS)
        assert.deepStrictEqual(yield* Vfs.encodeSnapshot(snapshot), encoded)

        for (const restored of [yield* Vfs.fromSnapshot(snapshot), yield* Vfs.makeOverlay(snapshot)]) {
          const fs = yield* restored.caller()
          assert.deepStrictEqual(yield* fs.readFile("/d/f"), new Uint8Array([1]))
          assert.strictEqual((yield* fs.stat("/d")).ino, BigInt(directory))
          assert.strictEqual((yield* fs.stat("/d/f")).ino, BigInt(file))

          const created = yield* fs.mkdir("/d/new")
          assert.strictEqual((yield* fs.stat(created.reference)).ino, BigInt(Math.max(directory, file) + 1))
          yield* fs.rename("/d/f", "/d/new/f")
          assert.deepStrictEqual(yield* fs.readFile("/d/new/f"), new Uint8Array([1]))
        }
      }
    }))

  it.effect("restores the largest inode a tree holds and then reports that none is left", () =>
    Effect.gen(function*() {
      const snapshot = yield* Vfs.decodeSnapshot(tree(2, Number.MAX_SAFE_INTEGER - 1), LIMITS)
      const fs = yield* (yield* Vfs.fromSnapshot(snapshot)).caller()

      assert.strictEqual((yield* fs.stat("/d/f")).ino, BigInt(Number.MAX_SAFE_INTEGER - 1))
      assert.strictEqual((yield* Effect.flip(fs.mkdir("/d/new"))).code, "NoSpace")
      yield* fs.unlink("/d/f")
      assert.strictEqual((yield* Effect.flip(fs.stat("/d/f"))).code, "NotFound")

      assert.deepStrictEqual(
        yield* Effect.map(
          Effect.flip(Vfs.decodeSnapshot(tree(2, Number.MAX_SAFE_INTEGER), LIMITS)),
          (error) => [error.code, error.field]
        ),
        ["InvalidStructure", "document"]
      )
    }))

  it.effect("refuses directories whose parents form a cycle nothing reaches", () =>
    Effect.gen(function*() {
      const cycle = toLines({
        format: "effect-vfs",
        version: 1,
        nodes: [
          { _tag: "directory", ino: 1, parent: 1, name: "", metadata: METADATA },
          { _tag: "directory", ino: 2, parent: 3, name: "YQ==", metadata: METADATA },
          { _tag: "directory", ino: 3, parent: 2, name: "Yg==", metadata: METADATA }
        ]
      })

      const error = yield* Effect.flip(Vfs.decodeSnapshot(cycle, LIMITS))
      assert.deepStrictEqual([error.code, error.field], ["InvalidStructure", "nodes.1.parent"])
    }))
})

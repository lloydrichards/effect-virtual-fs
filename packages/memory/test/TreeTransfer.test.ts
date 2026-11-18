import { Testing, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import { assert, describe, it } from "@effect/vitest"
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Function,
  Layer,
  Option,
  Predicate,
  Result,
  Schema,
  Stream
} from "effect"
import * as ByteSize from "effect/ByteSize"
import type * as Digest from "effect/crypto/Digest"
import type * as SecureRandom from "effect/crypto/SecureRandom"
import * as PlatformError from "effect/PlatformError"
import * as TestClock from "effect/testing/TestClock"
import * as MemoryFileSystem from "../src/MemoryFileSystem.js"
import * as TreeTransfer from "../src/TreeTransfer.js"
import { snapshotEntries } from "./support/snapshotEntries.js"
import { FOUR_FILES_FIXTURE, representativeTree } from "./support/treeTransferFixtures.js"

const entryNames = (listing: Vfs.ObjectObservation<ReadonlyArray<Vfs.DirectoryEntry>>) =>
  listing.value.map((entry) => new TextDecoder().decode(entry.name))

const text = new TextEncoder()

const OWNER = { uid: 1000, gid: 1000, groups: [], privileged: false }

const HOME_FIXTURE: Vfs.Fixture = {
  entries: [{ kind: "directory", path: "/home", metadata: { uid: OWNER.uid, gid: OWNER.gid } }]
}

const ACCESSED_FILE_FIXTURE: Vfs.Fixture = {
  entries: [{ kind: "file", path: "/file", bytes: text.encode("x"), metadata: { atimeNs: 5n } }]
}

const FILE_ROOT_FIXTURE: Vfs.Fixture = {
  entries: [
    { kind: "file", path: "/source", bytes: text.encode("new") },
    { kind: "file", path: "/existing", bytes: text.encode("old") }
  ]
}

const LONG_SYMLINK_FIXTURE: Vfs.Fixture = { entries: [{ kind: "symlink", path: "/link", target: "0123456789" }] }

const crossParentSymlinks: Vfs.Fixture = {
  entries: [
    ...["a", "b", "c"].flatMap((parent) => [
      { kind: "directory" as const, path: `/${parent}` },
      { kind: "file" as const, path: `/${parent}/target`, bytes: text.encode(parent) }
    ]),
    { kind: "symlink", path: "/a/link", target: "target" },
    { kind: "hardLink", path: "/b/link", target: "/a/link" },
    { kind: "hardLink", path: "/c/link", target: "/b/link" },
    { kind: "symlink", path: "/a/dangling", target: "missing" },
    { kind: "hardLink", path: "/b/dangling", target: "/a/dangling" }
  ]
}

const assertCrossParentSymlinks = Effect.fnUntraced(function*(caller: Vfs.Caller) {
  for (
    const { name, parents, target } of [
      { name: "link", parents: ["a", "b", "c"], target: "target" },
      { name: "dangling", parents: ["a", "b"], target: "missing" }
    ]
  ) {
    const reference = yield* caller.lookup(`/a/${name}`)

    for (const parent of parents) {
      const path = `/${parent}/${name}`
      const metadata = yield* caller.stat(Vfs.Target.Path({ path, followFinalSymlink: false }))
      assert.strictEqual(metadata.kind, "symlink")
      assert.strictEqual(metadata.nlink, parents.length)
      assert.strictEqual(yield* caller.lookup(path), reference)
      assert.deepStrictEqual(yield* caller.readLink(path), text.encode(target))

      if (name === "link") assert.deepStrictEqual(yield* caller.readFile(path), text.encode(parent))
      else assert.strictEqual((yield* Effect.flip(caller.readFile(path))).code, "NotFound")
    }
  }
})

const assertRepresentativeContents = Effect.fnUntraced(function*(caller: Vfs.Caller, root: string) {
  assert.deepStrictEqual(yield* caller.readFile(`${root}/nested/data.bin`), new Uint8Array([0, 255, 1, 254]))
  assert.strictEqual(new TextDecoder().decode(yield* caller.readLink(`${root}/relative`)), "nested/data.bin")
  assert.strictEqual(new TextDecoder().decode(yield* caller.readLink(`${root}/dangling`)), "missing")
  assert.strictEqual(new TextDecoder().decode(yield* caller.readLink(`${root}/escaping`)), "/etc/passwd")
  const raw = yield* Vfs.pathFromBytes(new Uint8Array([...text.encode(`${root}/raw-`), 0xff]))
  assert.deepStrictEqual(yield* caller.readFile(raw), text.encode("raw"))
})

const failure = <E>(error: E) => error instanceof TreeTransfer.TransferError ? [error.code, error.field] : error

const withoutChangeTimes = (entries: ReadonlyArray<TreeTransfer.Entry>) =>
  entries.map((entry) => {
    if (entry.kind === "hardLink" || entry.metadata === undefined) return entry
    const { ctimeNs: _ctime, birthtimeNs: _birthtime, ...metadata } = entry.metadata

    return { ...entry, metadata }
  })

const repeatedPathStreams: ReadonlyArray<{ name: string; entries: ReadonlyArray<TreeTransfer.Entry> }> = [
  {
    name: "file",
    entries: [
      { kind: "file", path: "/duplicate", bytes: text.encode("first") },
      { kind: "file", path: "/duplicate", bytes: text.encode("second") }
    ]
  },
  {
    name: "different entry kind",
    entries: [
      { kind: "file", path: "/duplicate", bytes: text.encode("first") },
      { kind: "directory", path: "/duplicate" }
    ]
  },
  {
    name: "directory",
    entries: [
      { kind: "directory", path: "/duplicate" },
      { kind: "directory", path: "/duplicate" }
    ]
  },
  {
    name: "symbolic link",
    entries: [
      { kind: "symlink", path: "/duplicate", target: "target" },
      { kind: "symlink", path: "/duplicate", target: "target" }
    ]
  },
  {
    name: "hard link",
    entries: [
      { kind: "hardLink", path: "/duplicate", target: "/target" },
      { kind: "hardLink", path: "/duplicate", target: "/target" }
    ]
  }
]

const repeatedPathStream = (entries: ReadonlyArray<TreeTransfer.Entry>) =>
  Stream.fromIterable([
    { kind: "directory", path: "/" } as const,
    { kind: "file", path: "/target", bytes: text.encode("target") } as const,
    ...entries
  ])

const assertRepeatedPath = Effect.fnUntraced(function*<A, E, R>(transfer: Effect.Effect<A, E, R>) {
  const error = yield* Effect.flip(transfer)

  if (!(error instanceof TreeTransfer.TransferError)) return assert.fail("Expected TransferError")

  assert.deepStrictEqual(failure(error), ["InvalidEntry", "path"])
  assert.strictEqual(error.path, "/duplicate")
})

it.layer(NodeCrypto.layer)("TreeTransfer repeated paths", (it) => {
  for (const { name, entries } of repeatedPathStreams) {
    it.effect(`should reject a repeated ${name} path when building a volume`, () =>
      assertRepeatedPath(TreeTransfer.toVolume(repeatedPathStream(entries))))

    for (const existing of ["reject", "overwrite"] as const) {
      it.effect(`should reject a repeated ${name} path when caller destination policy is ${existing}`, () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.fromFixture({ entries: [] })

          yield* assertRepeatedPath(Stream.run(
            repeatedPathStream(entries),
            TreeTransfer.toCaller(yield* volume.caller(), "/copy", { existing })
          ))
        }))
    }
  }
})

describe("TreeTransfer", () => {
  it.layer(NodeCrypto.layer)((it) => {
    for (const sourceKind of ["caller", "snapshot"] as const) {
      for (const destinationKind of ["caller", "volume"] as const) {
        it.effect(`should retain cross-parent symlink identity when transferring from ${sourceKind} to ${destinationKind}`, () =>
          Effect.gen(function*() {
            const source = yield* Vfs.fromFixture(crossParentSymlinks)

            const entries = sourceKind === "caller"
              ? TreeTransfer.fromCaller(yield* source.caller(), "/")
              : TreeTransfer.fromSnapshot(yield* source.snapshot, "/")

            if (destinationKind === "volume") {
              const destination = yield* TreeTransfer.toVolume(entries)
              yield* assertCrossParentSymlinks(yield* destination.caller())
            } else {
              const destination = yield* Vfs.make()
              const caller = yield* destination.caller()
              const report = yield* Stream.run(entries, TreeTransfer.toCaller(caller, "/copy"))
              assert.strictEqual(report.hardLinksDegraded, 0)
              yield* assertCrossParentSymlinks(yield* caller.withRoot("/copy"))
            }
          }))
      }
    }

    it.effect("should round-trip a representative tree between callers when all metadata is requested", () =>
      Effect.gen(function*() {
        const source = yield* representativeTree
        const destination = yield* Vfs.Volume
        const expected = yield* snapshotEntries(source, "/src")

        const report = yield* Stream.run(
          TreeTransfer.fromSnapshot(yield* source.snapshot, "/src"),
          TreeTransfer.toCaller(yield* Vfs.Caller, "/copy", { times: "all", specialBits: true })
        )

        assert.deepStrictEqual(
          withoutChangeTimes(yield* snapshotEntries(destination, "/copy")),
          withoutChangeTimes(expected)
        )
        assert.deepStrictEqual(report, {
          entries: 9,
          files: 2,
          bytes: ByteSize.bytes(7),
          skipped: [],
          hardLinksDegraded: 0
        })
        const copied = yield* destination.caller()
        yield* assertRepresentativeContents(copied, "/copy")
        assert.strictEqual(
          (yield* copied.stat(Vfs.Target.Path({ path: "/copy/alias.bin", followFinalSymlink: false }))).nlink,
          2
        )
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should keep every metadata field when building a new volume with owners and special bits requested", () =>
      Effect.gen(function*() {
        const source = yield* representativeTree
        const expected = yield* snapshotEntries(source, "/src")

        const volume = yield* TreeTransfer.fromSnapshot(yield* source.snapshot, "/src").pipe(
          TreeTransfer.toVolume({ owner: true, specialBits: true })
        )

        assert.deepStrictEqual(yield* snapshotEntries(volume, "/"), expected)
        const caller = yield* volume.caller()
        const data = yield* caller.stat("/nested/data.bin")
        assert.deepStrictEqual(
          { mode: data.mode, atimeNs: data.atimeNs, mtimeNs: data.mtimeNs, birthtimeNs: data.birthtimeNs },
          { mode: 0o4755, atimeNs: 31n, mtimeNs: 32n, birthtimeNs: 33n }
        )
        yield* assertRepresentativeContents(caller, "")
      }))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should apply mtime and strip special bits when writing with default options", () =>
      Effect.gen(function*() {
        const source = yield* representativeTree
        const destination = yield* Vfs.Caller

        yield* Stream.run(
          TreeTransfer.fromSnapshot(yield* source.snapshot, "/src"),
          TreeTransfer.toCaller(destination, "/copy")
        )

        const file = yield* destination.stat(
          Vfs.Target.Path({ path: "/copy/nested/data.bin", followFinalSymlink: false })
        )

        assert.deepStrictEqual({ mode: file.mode, mtimeNs: file.mtimeNs }, { mode: 0o755, mtimeNs: 32n })
        assert.notStrictEqual(file.atimeNs, 31n)
        assert.strictEqual(
          (yield* destination.stat(Vfs.Target.Path({ path: "/copy/nested", followFinalSymlink: false }))).mode,
          0o555
        )
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should write children of a read-only directory when the destination caller is unprivileged", () =>
      Effect.gen(function*() {
        const source = yield* representativeTree
        const owner = yield* Testing.callerAs(OWNER)

        yield* Stream.run(
          TreeTransfer.fromSnapshot(yield* source.snapshot, "/src"),
          TreeTransfer.toCaller(owner, "/home/copy")
        )

        assert.deepStrictEqual(entryNames(yield* owner.readDirectory("/home/copy/nested")), ["data.bin"])
        assert.strictEqual(
          (yield* owner.stat(Vfs.Target.Path({ path: "/home/copy/nested", followFinalSymlink: false }))).mode,
          0o555
        )
      }).pipe(Effect.provide(Testing.layer({ fixture: HOME_FIXTURE }))))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should leave an existing destination untouched when existing entries are rejected", () =>
      Effect.gen(function*() {
        const source = yield* representativeTree
        const destination = yield* Vfs.Caller
        yield* destination.mkdir("/copy")
        yield* destination.writeFile("/copy/keep", text.encode("keep"), { access: "write", create: "exclusive" })

        const error = yield* Effect.flip(
          Stream.run(
            TreeTransfer.fromSnapshot(yield* source.snapshot, "/src"),
            TreeTransfer.toCaller(destination, "/copy")
          )
        )

        assert.strictEqual(Schema.is(Vfs.VfsError)(error) && error.code, "AlreadyExists")
        assert.deepStrictEqual(entryNames(yield* destination.readDirectory("/copy")), ["keep"])
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should merge into and replace existing entries when overwriting", () =>
      Effect.gen(function*() {
        const source = yield* representativeTree
        const destination = yield* Vfs.Caller
        yield* destination.mkdir("/copy")
        yield* destination.writeFile("/copy/keep", text.encode("keep"), { access: "write", create: "exclusive" })
        yield* destination.writeFile("/copy/relative", text.encode("old"), { access: "write", create: "exclusive" })

        yield* Stream.run(
          TreeTransfer.fromSnapshot(yield* source.snapshot, "/src"),
          TreeTransfer.toCaller(destination, "/copy", { existing: "overwrite" })
        )

        assert.strictEqual(new TextDecoder().decode(yield* destination.readLink("/copy/relative")), "nested/data.bin")
        assert.strictEqual(
          (yield* destination.stat(Vfs.Target.Path({ path: "/copy/keep", followFinalSymlink: false }))).kind,
          "file"
        )
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should remove a claimed destination when the source fails mid-transfer", () =>
      Effect.gen(function*() {
        const source = yield* representativeTree
        const destination = yield* Vfs.Caller

        const failing = TreeTransfer.fromSnapshot(yield* source.snapshot, "/src").pipe(
          Stream.take(3),
          Stream.concat(Stream.fail("source failed"))
        )

        const exit = yield* Effect.exit(Stream.run(failing, TreeTransfer.toCaller(destination, "/copy")))

        assert.isTrue(Exit.isFailure(exit))
        assert.deepStrictEqual(entryNames(yield* destination.readDirectory("/")), [])
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should keep written entries when an overwriting transfer fails", () =>
      Effect.gen(function*() {
        const source = yield* representativeTree
        const destination = yield* Vfs.Caller

        const failing = TreeTransfer.fromSnapshot(yield* source.snapshot, "/src").pipe(
          Stream.take(2),
          Stream.concat(Stream.fail("source failed"))
        )

        yield* Effect.exit(Stream.run(failing, TreeTransfer.toCaller(destination, "/copy", { existing: "overwrite" })))

        assert.deepStrictEqual(entryNames(yield* destination.readDirectory("/copy")), ["alias.bin"])
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should exclude entries when the source stream is filtered", () =>
      Effect.gen(function*() {
        const source = yield* representativeTree

        const volume = yield* TreeTransfer.fromSnapshot(yield* source.snapshot, "/src").pipe(
          Stream.filter((entry) => !Predicate.isString(entry.path) || !entry.path.startsWith("/nested")),
          TreeTransfer.toVolume()
        )

        const missing = yield* Effect.flip(
          (yield* volume.caller()).stat(Vfs.Target.Path({ path: "/nested", followFinalSymlink: false }))
        )

        assert.strictEqual(missing.code, "NotFound")
      }))
  })

  for (
    const [field, limits] of [
      ["maxEntries", { maxEntries: 3 }],
      ["maxDepth", { maxDepth: 1 }],
      ["maxFileBytes", { maxFileBytes: ByteSize.bytes(3) }],
      ["maxBytes", { maxBytes: ByteSize.bytes(5) }],
      ["maxPathBytes", { maxPathBytes: ByteSize.bytes(8) }]
    ] as const
  ) {
    it.layer(NodeCrypto.layer)((it) => {
      it.effect(`should fail with the exceeded field when a source passes ${field}`, () =>
        Effect.gen(function*() {
          const source = yield* representativeTree

          const stream = TreeTransfer.fromSnapshot(yield* source.snapshot, "/src", {
            limits: { ...TreeTransfer.TreeTransferLimits.default, ...limits }
          })

          const error = yield* Effect.flip(Stream.runDrain(stream))

          assert.deepStrictEqual(failure(error), ["LimitExceeded", field])
        }))
    })
  }

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should reject a transfer when its limits policy is malformed", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        const limits = { ...TreeTransfer.TreeTransferLimits.default, maxEntries: -1 }

        const error = yield* Effect.flip(Stream.runDrain(TreeTransfer.fromCaller(caller, "/", { limits })))

        assert.deepStrictEqual(failure(error), ["InvalidArgument", "limits"])
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should preserve access time when a live read leaves relatime unchanged", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const [entry] = yield* Stream.runCollect(TreeTransfer.fromCaller(caller, "/file"))

        assert.strictEqual(entry?.kind === "file" && entry.metadata?.atimeNs, 5n)
        // The fixture's access time is newer than its modification time, so relatime leaves it in place.
        assert.strictEqual(
          (yield* caller.stat(Vfs.Target.Path({ path: "/file", followFinalSymlink: false }))).atimeNs,
          5n
        )
      }).pipe(Effect.provide(Testing.layer({ fixture: ACCESSED_FILE_FIXTURE }))))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should emit the original access time when reading advances source relatime", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* TestClock.setTime(86_400_001)

        const [entry] = yield* Stream.runCollect(TreeTransfer.fromCaller(caller, "/file"))

        assert.strictEqual(entry?.kind === "file" && entry.metadata?.atimeNs, 5n)
        assert.strictEqual((yield* caller.stat("/file")).atimeNs, 86_400_001_000_000n)
      }).pipe(Effect.provide(Testing.layer({ fixture: ACCESSED_FILE_FIXTURE }))))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should fail a transfer when the caller cannot search a directory", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const owner = yield* Vfs.Caller
        yield* owner.mkdir("/src/inner", { recursive: true })
        yield* owner.writeFile("/src/inner/file", text.encode("x"), { access: "write", create: "ifMissing" })
        yield* owner.chmod("/src", 0o444)
        const guest = yield* volume.caller({ identity: { uid: 1, gid: 1, groups: [], privileged: false } })
        const seen: Array<string> = []

        // Every entry is reached by its path and no directory is opened, so the root is read without searching it and
        // reaching /src/inner needs search permission on /src.
        const error = yield* Effect.flip(
          Stream.runForEach(TreeTransfer.fromCaller(guest, "/src"), (entry) =>
            Effect.sync(() => {
              seen.push(`${entry.kind} ${Predicate.isString(entry.path) ? entry.path : "<bytes>"}`)
            }))
        )

        assert.deepStrictEqual(seen, ["directory /"])
        assert.strictEqual(error.code, "AccessDenied")
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should leave the source unchanged when streaming from a snapshot", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const caller = yield* Vfs.Caller

        yield* Stream.runDrain(TreeTransfer.fromSnapshot(yield* volume.snapshot, "/file"))

        assert.strictEqual(
          (yield* caller.stat(Vfs.Target.Path({ path: "/file", followFinalSymlink: false }))).atimeNs,
          5n
        )
      }).pipe(Effect.provide(Testing.layer({ fixture: ACCESSED_FILE_FIXTURE }))))
  })

  for (
    const [name, entries, field] of [
      ["a child precedes the root", [{ kind: "directory", path: "/a" }], "root"],
      [
        "a child precedes its parent",
        [{ kind: "directory", path: "/" }, { kind: "directory", path: "/a/b" }],
        "parent"
      ],
      ["a root appears twice", [{ kind: "directory", path: "/" }, { kind: "directory", path: "/" }], "root"],
      ["a hard link names an unwritten target", [{ kind: "directory", path: "/" }, {
        kind: "hardLink",
        path: "/a",
        target: "/missing"
      }], "target"]
    ] satisfies ReadonlyArray<readonly [string, ReadonlyArray<TreeTransfer.Entry>, string]>
  ) {
    it.layer(NodeCrypto.layer)((it) => {
      it.effect(`should reject the stream when ${name}`, () =>
        Effect.gen(function*() {
          const destination = yield* Vfs.Caller

          const error = yield* Effect.flip(
            Stream.run(Stream.fromIterable(entries), TreeTransfer.toCaller(destination, "/copy"))
          )

          assert.deepStrictEqual(failure(error), ["InvalidEntry", field])
        }).pipe(Effect.provide(Testing.layer())))
    })
  }

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should require a root directory when building a new volume", () =>
      Effect.gen(function*() {
        const error = yield* Effect.flip(
          TreeTransfer.toVolume(Stream.make({ kind: "file", path: "/", bytes: new Uint8Array() } as const))
        )

        assert.deepStrictEqual(failure(error), ["InvalidEntry", "root"])
      }))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should leave an existing destination file untouched when a file root is rejected", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const error = yield* Effect.flip(
          Stream.run(TreeTransfer.fromCaller(caller, "/source"), TreeTransfer.toCaller(caller, "/existing"))
        )

        assert.strictEqual(Schema.is(Vfs.VfsError)(error) && error.code, "AlreadyExists")
        assert.strictEqual(new TextDecoder().decode(yield* caller.readFile("/existing")), "old")
      }).pipe(Effect.provide(Testing.layer({ fixture: FILE_ROOT_FIXTURE }))))
  })

  for (
    const [name, entry] of [
      ["a parent reference", { kind: "directory", path: "/.." }],
      ["a current-directory reference", { kind: "file", path: "/.", bytes: new Uint8Array() }],
      ["an empty component", { kind: "directory", path: "/a/" }]
    ] satisfies ReadonlyArray<readonly [string, TreeTransfer.Entry]>
  ) {
    it.layer(NodeCrypto.layer)((it) => {
      it.effect(`should reject ${name} when overwriting`, () =>
        Effect.gen(function*() {
          const destination = yield* Vfs.Caller
          yield* destination.mkdir("/copy")

          const error = yield* Effect.flip(
            Stream.run(
              Stream.make<ReadonlyArray<TreeTransfer.Entry>>({ kind: "directory", path: "/" }, entry),
              TreeTransfer.toCaller(destination, "/copy", { existing: "overwrite" })
            )
          )

          assert.deepStrictEqual(failure(error), ["InvalidEntry", "path"])
          assert.deepStrictEqual(entryNames(yield* destination.readDirectory("/")), ["copy"])
        }).pipe(Effect.provide(Testing.layer())))
    })
  }

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should reject a transfer when its source stream is empty", () =>
      Effect.gen(function*() {
        const destination = yield* Vfs.Caller

        const error = yield* Effect.flip(Stream.run(Stream.empty, TreeTransfer.toCaller(destination, "/copy")))

        assert.deepStrictEqual(failure(error), ["InvalidEntry", "root"])
      }).pipe(Effect.provide(Testing.layer())))
  })

  for (
    const [name, entries, field] of [
      ["a child precedes its parent", [{ kind: "directory", path: "/a/b" }], "parent"],
      ["a hard link precedes its target", [{ kind: "hardLink", path: "/a", target: "/b" }], "target"]
    ] satisfies ReadonlyArray<readonly [string, ReadonlyArray<TreeTransfer.Entry>, string]>
  ) {
    it.layer(NodeCrypto.layer)((it) => {
      it.effect(`should reject a new volume when ${name}`, () =>
        Effect.gen(function*() {
          const error = yield* Effect.flip(
            TreeTransfer.toVolume(
              Stream.fromIterable<TreeTransfer.Entry>([{ kind: "directory", path: "/" }, ...entries])
            )
          )

          assert.deepStrictEqual(failure(error), ["InvalidEntry", field])
        }))
    })
  }

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should drop owners and special bits when building a new volume by default", () =>
      Effect.gen(function*() {
        const volume = yield* TreeTransfer.toVolume(Stream.fromIterable<TreeTransfer.Entry>([
          { kind: "directory", path: "/", metadata: { uid: 501, gid: 20 } },
          { kind: "file", path: "/tool", bytes: new Uint8Array(), metadata: { uid: 501, gid: 20, mode: 0o4755 } }
        ]))

        const tool = yield* (yield* volume.caller()).stat(Vfs.Target.Path({ path: "/tool", followFinalSymlink: false }))

        assert.deepStrictEqual({ uid: tool.uid, gid: tool.gid, mode: tool.mode }, { uid: 0, gid: 0, mode: 0o755 })
      }))
  })

  for (
    const [field, exact, below] of [
      ["maxEntries", { maxEntries: 9 }, { maxEntries: 8 }],
      ["maxPathBytes", { maxPathBytes: ByteSize.bytes(16) }, { maxPathBytes: ByteSize.bytes(15) }]
    ] as const
  ) {
    it.layer(NodeCrypto.layer)((it) => {
      it.effect(`should accept the exact budget and identify overflow when ${field} is reduced by one`, () =>
        Effect.gen(function*() {
          const snapshot = yield* (yield* representativeTree).snapshot

          const drain = (limits: Partial<TreeTransfer.TreeTransferLimits>) =>
            Stream.runDrain(TreeTransfer.fromSnapshot(snapshot, "/src", {
              limits: { ...TreeTransfer.TreeTransferLimits.default, ...limits }
            }))

          yield* drain(exact)
          assert.deepStrictEqual(failure(yield* Effect.flip(drain(below))), ["LimitExceeded", field])
        }))
    })
  }

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should count symbolic-link targets when enforcing the byte limit", () =>
      Effect.gen(function*() {
        const limits = { ...TreeTransfer.TreeTransferLimits.default, maxBytes: ByteSize.bytes(9) }

        const error = yield* Effect.flip(
          Stream.runDrain(TreeTransfer.fromCaller(yield* Vfs.Caller, "/link", { limits }))
        )

        assert.deepStrictEqual(failure(error), ["LimitExceeded", "maxBytes"])
      }).pipe(Effect.provide(Testing.layer({ fixture: LONG_SYMLINK_FIXTURE }))))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should fail before visiting a directory when its listing exceeds the entry budget", () =>
      Effect.gen(function*() {
        const limits = { ...TreeTransfer.TreeTransferLimits.default, maxEntries: 3 }
        const entries: Array<TreeTransfer.Entry> = []

        const error = yield* Effect.flip(
          Stream.runForEach(
            TreeTransfer.fromCaller(yield* Vfs.Caller, "/", { limits }),
            (entry) => Effect.sync(() => entries.push(entry))
          )
        )

        assert.deepStrictEqual(failure(error), ["LimitExceeded", "maxEntries"])
        assert.deepStrictEqual(entries, [])
      }).pipe(Effect.provide(Testing.layer({ fixture: FOUR_FILES_FIXTURE }))))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should fail at the overflowing entry when a snapshot listing exceeds the budget", () =>
      Effect.gen(function*() {
        const limits = { ...TreeTransfer.TreeTransferLimits.default, maxEntries: 3 }
        const snapshot = yield* (yield* Vfs.fromFixture(FOUR_FILES_FIXTURE)).snapshot
        const paths: Array<Vfs.PathInput> = []

        const error = yield* Effect.flip(
          Stream.runForEach(
            TreeTransfer.fromSnapshot(snapshot, "/", { limits }),
            (entry) => Effect.sync(() => paths.push(entry.path))
          )
        )

        assert.deepStrictEqual(failure(error), ["LimitExceeded", "maxEntries"])
        assert.deepStrictEqual(paths, ["/", "/a", "/b"])
      }))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should restore final directory modes when an overwriting transfer fails", () =>
      Effect.gen(function*() {
        const destination = yield* Vfs.Caller

        const failing = Stream.fromIterable<TreeTransfer.Entry>([
          { kind: "directory", path: "/" },
          { kind: "directory", path: "/locked", metadata: { mode: 0o555 } }
        ]).pipe(Stream.concat(Stream.fail("source failed")))

        yield* Effect.exit(Stream.run(failing, TreeTransfer.toCaller(destination, "/copy", { existing: "overwrite" })))

        assert.strictEqual(
          (yield* destination.stat(Vfs.Target.Path({ path: "/copy/locked", followFinalSymlink: false }))).mode,
          0o555
        )
      }).pipe(Effect.provide(Testing.layer())))
  })
})

const millis = (value: number) => BigInt(value) * 1_000_000n

const hostTree = Vfs.fromFixture({
  entries: [
    { kind: "directory", path: "/src", metadata: { mode: 0o750, atimeNs: millis(1_000), mtimeNs: millis(2_000) } },
    { kind: "directory", path: "/src/nested", metadata: { mode: 0o700, mtimeNs: millis(3_000) } },
    {
      kind: "file",
      path: "/src/nested/data.bin",
      bytes: new Uint8Array([0, 255, 1, 254]),
      metadata: { mode: 0o755, atimeNs: millis(4_000), mtimeNs: millis(5_000) }
    },
    { kind: "hardLink", path: "/src/alias.bin", target: "/src/nested/data.bin" },
    { kind: "symlink", path: "/src/relative", target: "nested/data.bin" },
    { kind: "symlink", path: "/src/dangling", target: "missing" }
  ]
})

// Keeps only what an Effect FileSystem round trip promises: names, contents, link targets and topology, modes,
// and millisecond access and modification times. Link metadata, owners, and change and birth times are dropped.
const declared = (entries: ReadonlyArray<TreeTransfer.Entry>) =>
  entries.map((entry) => {
    switch (entry.kind) {
      case "hardLink":
        return entry
      case "symlink":
        return { kind: entry.kind, path: entry.path, target: entry.target }
      case "file":
        return {
          kind: entry.kind,
          path: entry.path,
          bytes: entry.bytes,
          mode: entry.metadata?.mode,
          atimeNs: entry.metadata?.atimeNs,
          mtimeNs: entry.metadata?.mtimeNs
        }
      case "directory":
        return { kind: entry.kind, path: entry.path, mode: entry.metadata?.mode, mtimeNs: entry.metadata?.mtimeNs }
    }
  })

const hostFailure = <E>(error: E) => error instanceof TreeTransfer.TransferError ? [error.code, error.path] : error

const withTemp = <A, E, R>(use: (fs: FileSystem.FileSystem, directory: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem

    return yield* use(fs, yield* fs.makeTempDirectoryScoped({ prefix: "tree-transfer-" }))
  }))

const byteOrderedTree = Vfs.fromFixture({
  entries: [
    { kind: "directory", path: "/src" },
    { kind: "directory", path: "/src/\uE000" },
    { kind: "file", path: "/src/\uE000/data", bytes: text.encode("x") },
    { kind: "hardLink", path: "/src/\u{10000}", target: "/src/\uE000/data" },
    { kind: "hardLink", path: "/src/\u{10001}", target: "/src/\uE000/data" }
  ]
})

const orderedEntries = [
  { kind: "directory", path: "/" },
  { kind: "directory", path: "/\uE000" },
  { kind: "file", path: "/\uE000/data" },
  { kind: "hardLink", path: "/\u{10000}", target: "/\uE000/data" },
  { kind: "hardLink", path: "/\u{10001}", target: "/\uE000/data" }
] satisfies Array<Pick<TreeTransfer.Entry, "kind" | "path"> & { target?: Vfs.PathInput }>

const assertByteOrder = (entries: ReadonlyArray<TreeTransfer.Entry>) =>
  assert.deepStrictEqual(
    entries.map((entry) =>
      entry.kind === "hardLink"
        ? { kind: entry.kind, path: entry.path, target: entry.target }
        : { kind: entry.kind, path: entry.path }
    ),
    orderedEntries
  )

it.layer(NodeCrypto.layer)("TreeTransfer source ordering", (it) => {
  it.effect("should preserve byte order and first hard-link aliases when reading a snapshot", () =>
    Effect.gen(function*() {
      const source = yield* byteOrderedTree
      assertByteOrder(yield* Stream.runCollect(TreeTransfer.fromSnapshot(yield* source.snapshot, "/src")))
    }))
  it.effect("should preserve byte order and first hard-link aliases when reading a caller", () =>
    Effect.gen(function*() {
      const source = yield* byteOrderedTree
      assertByteOrder(yield* Stream.runCollect(TreeTransfer.fromCaller(yield* source.caller(), "/src")))
    }))
})

const observeContentReads = (fs: FileSystem.FileSystem, observedPath: string, reads: Array<string>) => {
  const recordRead = (path: string) =>
    Effect.sync(() => {
      if (path === observedPath) reads.push(path)
    })

  return FileSystem.make({
    ...fs,
    open: (path, options) => recordRead(path).pipe(Effect.andThen(fs.open(path, options))),
    readFile: (path) => recordRead(path).pipe(Effect.andThen(fs.readFile(path)))
  })
}

const fileSystemSuite = (
  name: string,
  layer: Layer.Layer<FileSystem.FileSystem, never, Digest.Digest | SecureRandom.SecureRandom>
) =>
  it.layer(layer.pipe(Layer.provideMerge(NodeCrypto.layer)))(`TreeTransfer FileSystem (${name})`, (it) => {
    it.effect("should report rewritten symlink aliases when exporting cross-parent hard links", () =>
      withTemp((fs, directory) =>
        Effect.gen(function*() {
          const source = yield* Vfs.fromFixture(crossParentSymlinks)
          const root = `${directory}/export`

          const report = yield* Stream.run(
            TreeTransfer.fromSnapshot(yield* source.snapshot, "/"),
            TreeTransfer.toFileSystem(fs, root)
          )

          assert.strictEqual(report.hardLinksDegraded, 3)

          for (const parent of ["b", "c"]) {
            assert.strictEqual(yield* fs.readLink(`${root}/${parent}/link`), "../a/target")
            assert.strictEqual(yield* fs.readFileString(`${root}/${parent}/link`), "a")
          }

          assert.strictEqual(yield* fs.readLink(`${root}/b/dangling`), "../a/missing")
          assert.isFalse(yield* fs.exists(`${root}/b/dangling`))
          yield* assertCrossParentSymlinks(yield* source.caller())
        })
      ))

    for (const { name, entries } of repeatedPathStreams) {
      for (const existing of ["reject", "overwrite"] as const) {
        it.effect(`should reject a repeated ${name} path when FileSystem destination policy is ${existing}`, () =>
          withTemp((fs, directory) =>
            assertRepeatedPath(Stream.run(
              repeatedPathStream(entries),
              TreeTransfer.toFileSystem(fs, `${directory}/copy`, { existing })
            ))
          ))
      }
    }

    it.effect("should reject a repeated path when its first entry was skipped", () =>
      withTemp((fs, directory) =>
        Effect.gen(function*() {
          const first: TreeTransfer.Entry = { kind: "file", path: "/duplicate", bytes: text.encode("first") }
          const entries = [first, { kind: "file", path: "/duplicate", bytes: text.encode("second") } as const]

          const stream = repeatedPathStream(entries).pipe(
            Stream.tap((entry) =>
              entry === first ? fs.writeFileString(`${directory}/copy/duplicate`, "existing") : Effect.void
            )
          )

          yield* assertRepeatedPath(Stream.run(
            stream,
            TreeTransfer.toFileSystem(fs, `${directory}/copy`, { unsupported: "skip" })
          ))

          assert.isFalse(yield* fs.exists(`${directory}/copy`))
        })
      ))

    it.effect("should reject a repeated string path when its byte-path equivalent was skipped", () =>
      withTemp((fs, directory) =>
        Effect.gen(function*() {
          const path = yield* Vfs.pathFromBytes(text.encode("/duplicate"))

          const entries: ReadonlyArray<TreeTransfer.Entry> = [
            { kind: "file", path, bytes: text.encode("first") },
            { kind: "file", path: "/duplicate", bytes: text.encode("second") }
          ]

          yield* assertRepeatedPath(Stream.run(
            repeatedPathStream(entries),
            TreeTransfer.toFileSystem(fs, `${directory}/copy`, { unsupported: "skip" })
          ))
        })
      ))

    it.effect("should keep the first write when overwrite rejects a repeated path", () =>
      withTemp((fs, directory) =>
        Effect.gen(function*() {
          yield* fs.makeDirectory(`${directory}/copy`)
          yield* fs.writeFileString(`${directory}/copy/duplicate`, "existing")

          yield* assertRepeatedPath(Stream.run(
            repeatedPathStream(repeatedPathStreams[0]!.entries),
            TreeTransfer.toFileSystem(fs, `${directory}/copy`, { existing: "overwrite" })
          ))
          assert.strictEqual(yield* fs.readFileString(`${directory}/copy/duplicate`), "first")
        })
      ))

    it.effect("should preserve byte order and first hard-link aliases when reading FileSystem", () =>
      withTemp((fs, directory) =>
        Effect.gen(function*() {
          const source = yield* byteOrderedTree
          yield* Stream.run(
            TreeTransfer.fromSnapshot(yield* source.snapshot, "/src"),
            TreeTransfer.toFileSystem(fs, `${directory}/export`)
          )
          assertByteOrder(yield* Stream.runCollect(TreeTransfer.fromFileSystem(fs, `${directory}/export`)))
        })
      ))

    it.effect("should round-trip a representative tree within declared losses when transferred through the host", () =>
      withTemp((fs, directory) =>
        Effect.gen(function*() {
          const source = yield* hostTree
          const expected = yield* snapshotEntries(source, "/src")

          const exported = yield* Stream.run(
            TreeTransfer.fromSnapshot(yield* source.snapshot, "/src"),
            TreeTransfer.toFileSystem(fs, `${directory}/export`, { times: "all" })
          )

          const imported = yield* TreeTransfer.toVolume(TreeTransfer.fromFileSystem(fs, `${directory}/export`))

          assert.deepStrictEqual(declared(yield* snapshotEntries(imported, "/")), declared(expected))
          assert.deepStrictEqual(exported.hardLinksDegraded, 0)
          const caller = yield* imported.caller()
          assert.deepStrictEqual(yield* caller.readFile("/nested/data.bin"), new Uint8Array([0, 255, 1, 254]))
          assert.strictEqual(new TextDecoder().decode(yield* caller.readLink("/relative")), "nested/data.bin")
          assert.strictEqual(new TextDecoder().decode(yield* caller.readLink("/dangling")), "missing")
          assert.strictEqual((yield* caller.stat("/nested")).mode, 0o700)
          assert.strictEqual(
            (yield* (yield* imported.caller()).stat(Vfs.Target.Path({ path: "/alias.bin", followFinalSymlink: false })))
              .nlink,
            2
          )
        })
      ))

    it.effect("should remove the claimed destination when a link escapes the tree", () =>
      withTemp((fs, directory) =>
        Effect.gen(function*() {
          const entries: ReadonlyArray<TreeTransfer.Entry> = [
            { kind: "directory", path: "/" },
            { kind: "file", path: "/keep", bytes: text.encode("x") },
            { kind: "symlink", path: "/passwd", target: "/etc/passwd" }
          ]

          const error = yield* Effect.flip(
            Stream.run(Stream.fromIterable(entries), TreeTransfer.toFileSystem(fs, `${directory}/export`))
          )

          assert.deepStrictEqual(hostFailure(error), ["EscapingSymlink", "/passwd"])
          assert.isFalse(yield* fs.exists(`${directory}/export`))
        })
      ))

    it.effect("should preserve a link when its resolved chain stays inside the tree", () =>
      withTemp((fs, directory) =>
        Effect.gen(function*() {
          const inside: ReadonlyArray<TreeTransfer.Entry> = [
            { kind: "directory", path: "/" },
            { kind: "directory", path: "/dir" },
            { kind: "symlink", path: "/dir/up", target: ".." },
            { kind: "symlink", path: "/ok", target: "dir/up/dir" }
          ]

          yield* Stream.run(Stream.fromIterable(inside), TreeTransfer.toFileSystem(fs, `${directory}/inside`))

          assert.strictEqual(yield* fs.readLink(`${directory}/inside/ok`), "dir/up/dir")
        })
      ))

    it.effect("should reject a link when its resolved chain leaves the tree", () =>
      withTemp((fs, directory) =>
        Effect.gen(function*() {
          const inside: ReadonlyArray<TreeTransfer.Entry> = [
            { kind: "directory", path: "/" },
            { kind: "directory", path: "/dir" },
            { kind: "symlink", path: "/dir/up", target: ".." },
            { kind: "symlink", path: "/ok", target: "dir/up/dir" }
          ]

          const outside: ReadonlyArray<TreeTransfer.Entry> = [...inside, {
            kind: "symlink",
            path: "/out",
            target: "dir/up/.."
          }]

          const error = yield* Effect.flip(
            Stream.run(Stream.fromIterable(outside), TreeTransfer.toFileSystem(fs, `${directory}/outside`))
          )

          assert.deepStrictEqual(hostFailure(error), ["EscapingSymlink", "/out"])
        })
      ))

    it.effect("should create an escaping link when escapes are allowed", () =>
      withTemp((fs, directory) =>
        Effect.gen(function*() {
          const entries: ReadonlyArray<TreeTransfer.Entry> = [
            { kind: "directory", path: "/" },
            { kind: "symlink", path: "/passwd", target: "/etc/passwd" }
          ]

          yield* Stream.run(
            Stream.fromIterable(entries),
            TreeTransfer.toFileSystem(fs, `${directory}/export`, { escaping: "allow" })
          )

          assert.strictEqual(yield* fs.readLink(`${directory}/export/passwd`), "/etc/passwd")
        })
      ))

    it.effect("should reject an unrepresentable name when unsupported entries are strict", () =>
      withTemp((fs, directory) =>
        Effect.gen(function*() {
          const raw = yield* Vfs.pathFromBytes(new Uint8Array([...text.encode("/raw-"), 0xff]))

          const entries: ReadonlyArray<TreeTransfer.Entry> = [
            { kind: "directory", path: "/" },
            { kind: "file", path: "/plain", bytes: text.encode("x") },
            { kind: "file", path: raw, bytes: text.encode("y") }
          ]

          const error = yield* Effect.flip(
            Stream.run(Stream.fromIterable(entries), TreeTransfer.toFileSystem(fs, `${directory}/strict`))
          )

          assert.deepStrictEqual(hostFailure(error), ["UnrepresentableName", raw])
        })
      ))

    it.effect("should report and omit an unrepresentable name when unsupported entries are skipped", () =>
      withTemp((fs, directory) =>
        Effect.gen(function*() {
          const raw = yield* Vfs.pathFromBytes(new Uint8Array([...text.encode("/raw-"), 0xff]))

          const entries: ReadonlyArray<TreeTransfer.Entry> = [
            { kind: "directory", path: "/" },
            { kind: "file", path: "/plain", bytes: text.encode("x") },
            { kind: "file", path: raw, bytes: text.encode("y") }
          ]

          const report = yield* Stream.run(
            Stream.fromIterable(entries),
            TreeTransfer.toFileSystem(fs, `${directory}/lenient`, { unsupported: "skip" })
          )

          assert.deepStrictEqual(report.skipped, [{ path: raw, reason: "UnrepresentableName" }])
          assert.deepStrictEqual(yield* fs.readDirectory(`${directory}/lenient`), ["plain"])
        })
      ))

    it.effect("should report a name collision when it occurs inside a claimed destination", () =>
      withTemp((fs, directory) =>
        Effect.gen(function*() {
          const entries: ReadonlyArray<TreeTransfer.Entry> = [
            { kind: "directory", path: "/" },
            { kind: "file", path: "/name", bytes: text.encode("second") }
          ]

          const report = yield* Stream.run(
            Stream.fromIterable(entries).pipe(
              Stream.tap((entry) =>
                entry.path === "/name" ? fs.writeFileString(`${directory}/export/name`, "first") : Effect.void
              )
            ),
            TreeTransfer.toFileSystem(fs, `${directory}/export`, { unsupported: "skip" })
          )

          assert.deepStrictEqual(report.skipped, [{ path: "/name", reason: "NameCollision" }])
          assert.strictEqual(yield* fs.readFileString(`${directory}/export/name`), "first")
        })
      ))

    it.effect("should replace a destination link without writing through it when overwriting", () =>
      withTemp((fs, directory) =>
        Effect.gen(function*() {
          yield* fs.writeFileString(`${directory}/outside`, "untouched")
          yield* fs.makeDirectory(`${directory}/export`)
          yield* fs.symlink(`${directory}/outside`, `${directory}/export/file`)

          const entries: ReadonlyArray<TreeTransfer.Entry> = [
            { kind: "directory", path: "/" },
            { kind: "file", path: "/file", bytes: text.encode("copied") }
          ]

          yield* Stream.run(
            Stream.fromIterable(entries),
            TreeTransfer.toFileSystem(fs, `${directory}/export`, { existing: "overwrite" })
          )

          assert.strictEqual(yield* fs.readFileString(`${directory}/outside`), "untouched")
          assert.strictEqual(yield* fs.readFileString(`${directory}/export/file`), "copied")
          assert.isTrue(Result.isFailure(yield* Effect.result(fs.readLink(`${directory}/export/file`))))
        })
      ))

    it.effect("should refuse a merge when the destination directory is a link", () =>
      withTemp((fs, directory) =>
        Effect.gen(function*() {
          yield* fs.makeDirectory(`${directory}/outside`)
          yield* fs.makeDirectory(`${directory}/export`)
          yield* fs.symlink(`${directory}/outside`, `${directory}/export/child`)

          const entries: ReadonlyArray<TreeTransfer.Entry> = [
            { kind: "directory", path: "/" },
            { kind: "directory", path: "/child" },
            { kind: "file", path: "/child/file", bytes: text.encode("copied") }
          ]

          const error = yield* Effect.flip(
            Stream.run(
              Stream.fromIterable(entries),
              TreeTransfer.toFileSystem(fs, `${directory}/export`, { existing: "overwrite" })
            )
          )

          assert.deepStrictEqual(hostFailure(error), ["DestinationConflict", "/child"])
          assert.deepStrictEqual(yield* fs.readDirectory(`${directory}/outside`), [])
        })
      ))

    it.effect("should reject a FIFO without reading it when unsupported entries are strict", () =>
      withTemp((fs, directory) =>
        Effect.gen(function*() {
          yield* fs.makeDirectory(`${directory}/tree`)
          yield* fs.writeFileString(`${directory}/tree/file`, "x")
          yield* fs.writeFileString(`${directory}/tree/pipe`, "never read")
          const reads: Array<string> = []

          // Reports one regular file as a FIFO, so the adapter must classify it by type and never read it.
          const withFifo = FileSystem.make({
            ...observeContentReads(fs, `${directory}/tree/pipe`, reads),
            lstat: (path) =>
              fs.lstat(path).pipe(
                Effect.map((info) => path.endsWith("/pipe") ? { ...info, type: "FIFO" as const } : info)
              )
          })

          const error = yield* Effect.flip(Stream.runDrain(TreeTransfer.fromFileSystem(withFifo, `${directory}/tree`)))

          assert.deepStrictEqual(hostFailure(error), ["UnsupportedEntryType", "/pipe"])
          assert.deepStrictEqual(reads, [])
        })
      ))

    it.effect("should report and omit a FIFO and a name containing the replacement character", () =>
      withTemp((fs, directory) =>
        Effect.gen(function*() {
          yield* fs.makeDirectory(`${directory}/tree`)
          yield* fs.writeFileString(`${directory}/tree/file`, "x")
          yield* fs.writeFileString(`${directory}/tree/pipe`, "never read")
          yield* fs.writeFileString(`${directory}/tree/\uFFFD`, "never read")
          const skipped: Array<TreeTransfer.SkippedEntry> = []
          const reads: Array<string> = []

          // Reports one regular file as a FIFO, so the adapter must classify it by type and never read it.
          const withFifo = FileSystem.make({
            ...observeContentReads(fs, `${directory}/tree/pipe`, reads),
            lstat: (path) =>
              fs.lstat(path).pipe(
                Effect.map((info) => path.endsWith("/pipe") ? { ...info, type: "FIFO" as const } : info)
              )
          })

          const entries = yield* Stream.runCollect(
            TreeTransfer.fromFileSystem(withFifo, `${directory}/tree`, {
              unsupported: "skip",
              onSkip: (entry) => Effect.sync(() => skipped.push(entry))
            })
          )

          assert.deepStrictEqual(entries.map((entry) => entry.path), ["/", "/file"])
          assert.deepStrictEqual(skipped, [
            { path: "/pipe", reason: "UnsupportedEntryType" },
            { path: "/\uFFFD", reason: "UnrepresentableName" }
          ])
          assert.deepStrictEqual(reads, [])
        })
      ))

    it.effect("should fail before reading a host file when it exceeds the byte limit", () =>
      withTemp((fs, directory) =>
        Effect.gen(function*() {
          yield* fs.writeFile(`${directory}/large`, new Uint8Array(1024))
          const limits = { ...TreeTransfer.TreeTransferLimits.default, maxFileBytes: ByteSize.bytes(16) }

          const reads: Array<string> = []

          const observed = observeContentReads(fs, `${directory}/large`, reads)

          const error = yield* Effect.flip(
            Stream.runDrain(TreeTransfer.fromFileSystem(observed, `${directory}/large`, { limits }))
          )

          assert.deepStrictEqual(hostFailure(error), ["LimitExceeded", "/"])
          assert.deepStrictEqual(reads, [])
        })
      ))

    it.effect("should reject a link when it escapes through an existing destination link", () =>
      withTemp((fs, directory) =>
        Effect.gen(function*() {
          yield* fs.makeDirectory(`${directory}/export`)
          yield* fs.symlink("..", `${directory}/export/up`)

          const entries: ReadonlyArray<TreeTransfer.Entry> = [
            { kind: "directory", path: "/" },
            { kind: "symlink", path: "/m", target: "up/SECRET" }
          ]

          const error = yield* Effect.flip(
            Stream.run(
              Stream.fromIterable(entries),
              TreeTransfer.toFileSystem(fs, `${directory}/export`, { existing: "overwrite" })
            )
          )

          assert.deepStrictEqual(hostFailure(error), ["EscapingSymlink", "/m"])
          assert.isFalse(yield* fs.exists(`${directory}/export/m`))
        })
      ))

    it.effect("should report a hard-link collision when a destination name already exists", () =>
      withTemp((fs, directory) =>
        Effect.gen(function*() {
          const entries: ReadonlyArray<TreeTransfer.Entry> = [
            { kind: "directory", path: "/" },
            { kind: "file", path: "/a", bytes: text.encode("A") },
            { kind: "hardLink", path: "/b", target: "/a" }
          ]

          const report = yield* Stream.run(
            Stream.fromIterable(entries).pipe(
              Stream.tap((entry) =>
                entry.path === "/b" ? fs.writeFileString(`${directory}/export/b`, "B") : Effect.void
              )
            ),
            TreeTransfer.toFileSystem(fs, `${directory}/export`, { unsupported: "skip" })
          )

          assert.deepStrictEqual(report.skipped, [{ path: "/b", reason: "NameCollision" }])
          assert.strictEqual(report.hardLinksDegraded, 0)
          assert.strictEqual(yield* fs.readFileString(`${directory}/export/b`), "B")
        })
      ))

    it.effect("should fail a hard-link transfer when its name collides", () =>
      withTemp((fs, directory) =>
        Effect.gen(function*() {
          const entries: ReadonlyArray<TreeTransfer.Entry> = [
            { kind: "directory", path: "/" },
            { kind: "file", path: "/a", bytes: text.encode("A") },
            { kind: "hardLink", path: "/b", target: "/a" }
          ]

          const error = yield* Effect.flip(
            Stream.run(
              Stream.fromIterable(entries).pipe(
                Stream.tap((entry) =>
                  entry.path === "/b" ? fs.writeFileString(`${directory}/export/b`, "B") : Effect.void
                )
              ),
              TreeTransfer.toFileSystem(fs, `${directory}/export`)
            )
          )

          assert.deepStrictEqual(hostFailure(error), ["NameCollision", "/b"])
        })
      ))

    it.effect("should apply exact modes when directory and file modes are requested", () =>
      withTemp((fs, directory) =>
        Effect.gen(function*() {
          const entries: ReadonlyArray<TreeTransfer.Entry> = [
            { kind: "directory", path: "/", metadata: { mode: 0o775 } },
            { kind: "file", path: "/open", bytes: text.encode("x"), metadata: { mode: 0o777 } }
          ]

          yield* Stream.run(Stream.fromIterable(entries), TreeTransfer.toFileSystem(fs, `${directory}/export`))

          assert.strictEqual((yield* fs.stat(`${directory}/export`)).mode & 0o777, 0o775)
          assert.strictEqual((yield* fs.stat(`${directory}/export/open`)).mode & 0o777, 0o777)
        })
      ))

    it.effect("should truncate sub-millisecond times when transferred through the host", () =>
      withTemp((fs, directory) =>
        Effect.gen(function*() {
          const entries: ReadonlyArray<TreeTransfer.Entry> = [
            { kind: "directory", path: "/" },
            { kind: "file", path: "/file", bytes: text.encode("x"), metadata: { mtimeNs: millis(5_000) + 123_456n } }
          ]

          yield* Stream.run(Stream.fromIterable(entries), TreeTransfer.toFileSystem(fs, `${directory}/export`))
          const [, file] = yield* Stream.runCollect(TreeTransfer.fromFileSystem(fs, `${directory}/export`))

          assert.strictEqual(file?.kind === "file" && file.metadata?.mtimeNs, millis(5_000))
        })
      ))

    it.effect("should skip a directory subtree when its name collides", () =>
      withTemp((fs, directory) =>
        Effect.gen(function*() {
          const entries: ReadonlyArray<TreeTransfer.Entry> = [
            { kind: "directory", path: "/" },
            { kind: "directory", path: "/d" },
            { kind: "file", path: "/d/y", bytes: text.encode("y") }
          ]

          const report = yield* Stream.run(
            Stream.fromIterable(entries).pipe(Stream.tap((entry) =>
              entry.path === "/d"
                ? fs.makeDirectory(`${directory}/export/d`).pipe(
                  Effect.andThen(fs.writeFileString(`${directory}/export/d/x`, "x"))
                )
                : Effect.void
            )),
            TreeTransfer.toFileSystem(fs, `${directory}/export`, { unsupported: "skip" })
          )

          assert.deepStrictEqual(report.skipped, [
            { path: "/d", reason: "NameCollision" },
            { path: "/d/y", reason: "NameCollision" }
          ])
          assert.deepStrictEqual(yield* fs.readDirectory(`${directory}/export/d`), ["x"])
        })
      ))

    it.effect("should emit a symbolic link when its target forms a loop", () =>
      withTemp((fs, directory) =>
        Effect.gen(function*() {
          yield* fs.makeDirectory(`${directory}/tree`)
          yield* fs.symlink("self", `${directory}/tree/self`)

          const entries = yield* Stream.runCollect(TreeTransfer.fromFileSystem(fs, `${directory}/tree`))

          assert.deepStrictEqual(entries[1], { kind: "symlink", path: "/self", target: "self" })
        })
      ))

    it.effect("should emit symlink roots and aliases without traversing their targets", () =>
      withTemp((fs, directory) =>
        Effect.gen(function*() {
          const tree = `${directory}/tree`
          yield* fs.makeDirectory(tree)
          yield* fs.makeDirectory(`${tree}/target`)
          yield* fs.writeFileString(`${tree}/target/file`, "x")
          yield* fs.symlink("target", `${tree}/link`)
          yield* fs.link(`${tree}/link`, `${tree}/alias`)

          const entries = yield* Stream.runCollect(TreeTransfer.fromFileSystem(fs, tree))
          assert.deepStrictEqual(entries.map((entry) => entry.path), [
            "/",
            "/alias",
            "/link",
            "/target",
            "/target/file"
          ])
          assert.deepStrictEqual(entries[1], { kind: "symlink", path: "/alias", target: "target" })
          assert.deepStrictEqual(entries[2], { kind: "symlink", path: "/link", target: "target" })

          const root = yield* Stream.runCollect(TreeTransfer.fromFileSystem(fs, `${tree}/link`))
          assert.deepStrictEqual(root, [{ kind: "symlink", path: "/", target: "target" }])
        })
      ))

    it.effect("should keep unreadable entries as filesystem failures even when unsupported entries are skipped", () =>
      withTemp((fs, directory) =>
        Effect.gen(function*() {
          const file = `${directory}/file`
          const link = `${directory}/link`
          yield* fs.writeFileString(file, "x")
          yield* fs.symlink("file", link)

          const statFailure = PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "lstat"
          })

          const linkFailure = PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readLink"
          })

          const unreadable = FileSystem.make({
            ...fs,
            lstat: (path) => path === file ? Effect.fail(statFailure) : fs.lstat(path),
            readLink: (path) => path === link ? Effect.fail(linkFailure) : fs.readLink(path)
          })

          const skipped: Array<TreeTransfer.SkippedEntry> = []

          const options: TreeTransfer.FileSystemReadOptions = {
            unsupported: "skip",
            onSkip: (entry) => Effect.sync(() => skipped.push(entry))
          }

          for (const [root, expected] of [[directory, statFailure], [link, linkFailure]] as const) {
            const actual = yield* Effect.flip(Stream.runDrain(TreeTransfer.fromFileSystem(unreadable, root, options)))
            assert.strictEqual(actual, expected)
          }

          assert.deepStrictEqual(skipped, [])
        })
      ))

    it.effect("should reject a host transfer when its source stream is empty", () =>
      withTemp((fs, directory) =>
        Effect.gen(function*() {
          const error = yield* Effect.flip(
            Stream.run(Stream.empty, TreeTransfer.toFileSystem(fs, `${directory}/export`))
          )

          assert.deepStrictEqual(hostFailure(error), ["InvalidEntry", undefined])
        })
      ))
  })

fileSystemSuite("Node", NodeFileSystem.layer)

fileSystemSuite("Memory", MemoryFileSystem.layer)

describe("Transfer fidelity", () => {
  const rejectedRequirements = [
    { required: { byteNames: true }, field: "byteNames" },
    { required: { timestampPrecision: "nanosecond" }, field: "timestampPrecision" },
    { required: { owner: true }, field: "owner" },
    { required: { changeAndBirthTimes: true }, field: "changeAndBirthTimes" },
    { required: { symlinkMetadata: true }, field: "symlinkMetadata" },
    { required: { hardLinks: "exact" }, field: "hardLinks" }
  ] as const

  it.layer(NodeCrypto.layer)("Transfer fidelity", (it) => {
    for (const existing of ["reject", "overwrite"] as const) {
      for (const { required, field } of rejectedRequirements) {
        it.effect(`should reject required ${field} before FileSystem writes with ${existing} policy`, () =>
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem.pipe(Effect.provide(MemoryFileSystem.layer))

            if (existing === "overwrite") {
              yield* fs.makeDirectory("/copy")
              yield* fs.writeFileString("/copy/a", "keep")
            }

            const source = yield* Vfs.fromFixture(FOUR_FILES_FIXTURE)

            const error = yield* Effect.flip(Stream.run(
              TreeTransfer.fromSnapshot(yield* source.snapshot, "/"),
              TreeTransfer.toFileSystem(fs, "/copy", { existing, required, unsupported: "skip" })
            ))

            assert.instanceOf(error, TreeTransfer.TransferError)

            if (error instanceof TreeTransfer.TransferError) {
              assert.strictEqual(error.code, "UnsupportedFidelity")
              assert.strictEqual(error.field, field)
            }

            if (existing === "overwrite") {
              assert.deepStrictEqual(yield* fs.readDirectory("/copy"), ["a"])
              assert.strictEqual(yield* fs.readFileString("/copy/a"), "keep")
            } else assert.isFalse(yield* fs.exists("/copy"))
          }))
      }
    }

    for (
      const options of [
        { required: { owner: true } },
        { required: { changeAndBirthTimes: true } },
        { required: { specialBits: true } },
        { times: "none", required: { timestampPrecision: "nanosecond" } },
        { required: { times: "all" } }
      ] satisfies ReadonlyArray<TreeTransfer.WriteOptions>
    ) {
      it.effect(`should reject incompatible caller fidelity ${JSON.stringify(options)} before changing the destination`, () =>
        Effect.gen(function*() {
          const caller = yield* (yield* Vfs.make()).caller()
          yield* caller.mkdir("/copy")
          yield* caller.writeFile("/copy/a", new TextEncoder().encode("keep"), { create: "exclusive", access: "write" })
          const source = yield* Vfs.fromFixture(FOUR_FILES_FIXTURE)

          const error = yield* Effect.flip(Stream.run(
            TreeTransfer.fromSnapshot(yield* source.snapshot, "/"),
            TreeTransfer.toCaller(caller, "/copy", { existing: "overwrite", ...options })
          ))

          assert.instanceOf(error, TreeTransfer.TransferError)

          if (error instanceof TreeTransfer.TransferError) assert.strictEqual(error.code, "UnsupportedFidelity")
          assert.deepStrictEqual(
            (yield* caller.readDirectory("/copy")).value.map((entry) => new TextDecoder().decode(entry.name)),
            ["a"]
          )
          assert.deepStrictEqual(yield* caller.readFile("/copy/a"), new TextEncoder().encode("keep"))
        }))
    }

    for (
      const options of [
        { required: { owner: true } },
        { required: { specialBits: true } }
      ] satisfies ReadonlyArray<TreeTransfer.VolumeTransferOptions>
    ) {
      it.effect(`should reject disabled volume fidelity ${JSON.stringify(options)} before consuming entries`, () =>
        Effect.gen(function*() {
          const error = yield* Effect.flip(TreeTransfer.toVolume(Stream.die("source must not run"), options))
          assert.instanceOf(error, TreeTransfer.TransferError)

          if (error instanceof TreeTransfer.TransferError) assert.strictEqual(error.code, "UnsupportedFidelity")
        }))
    }

    for (const destination of ["caller", "fileSystem"] as const) {
      it.effect(`should reject unsupported ${destination} fidelity before consuming a failing source`, () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.make()
          const caller = yield* volume.caller()
          const fs = yield* MemoryFileSystem.bindCaller(caller)
          const options = { required: { owner: true } }

          const sink = destination === "caller"
            ? TreeTransfer.toCaller(caller, "/copy", options)
            : TreeTransfer.toFileSystem(fs, "/copy", options)

          const error = yield* Effect.flip(Stream.run(Stream.die("source must not run"), sink))
          assert.instanceOf(error, TreeTransfer.TransferError)

          if (error instanceof TreeTransfer.TransferError) {
            assert.strictEqual(error.code, "UnsupportedFidelity")
            assert.strictEqual(error.field, "owner")
          }

          assert.isFalse(yield* fs.exists("/copy"))
        }))
    }

    for (const required of [{ hardLinks: "sometimes" }, { owner: "true" }, { unknownGuarantee: true }, null]) {
      it.effect(`should reject malformed requirements ${JSON.stringify(required)} with a typed error`, () =>
        Effect.gen(function*() {
          const error = yield* Effect.flip(TreeTransfer.toVolume(Stream.die("source must not run"), {
            // @ts-expect-error Deliberately exercise malformed JavaScript input at the public boundary.
            required
          }))

          assert.instanceOf(error, TreeTransfer.TransferError)

          if (error instanceof TreeTransfer.TransferError) {
            assert.strictEqual(error.code, "InvalidArgument")
            assert.strictEqual(error.field, "required")
          }
        }))
    }

    for (const destination of ["caller", "fileSystem", "nodeFileSystem"] as const) {
      it.effect(`should preserve a supplied access time without mtime when ${destination} requires all selected times`, () =>
        Effect.gen(function*() {
          const caller = yield* (yield* Vfs.make()).caller()

          const fs = destination === "nodeFileSystem"
            ? yield* FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer))
            : yield* MemoryFileSystem.bindCaller(caller)

          const root = destination === "nodeFileSystem"
            ? `${yield* fs.makeTempDirectoryScoped({ prefix: "transfer-fidelity-" })}/copy`
            : "/copy"

          const options: TreeTransfer.WriteOptions = { times: "all", required: { times: "all" } }

          const sink = destination === "caller"
            ? TreeTransfer.toCaller(caller, root, options)
            : TreeTransfer.toFileSystem(fs, root, options)

          yield* Stream.run(
            Stream.fromIterable<TreeTransfer.Entry>([
              { kind: "directory", path: "/" },
              { kind: "file", path: "/a", bytes: new Uint8Array(), metadata: { atimeNs: 1_234_567_890n } }
            ]),
            sink
          )

          if (destination === "caller") assert.strictEqual((yield* caller.stat(`${root}/a`)).atimeNs, 1_234_567_890n)
          else assert.strictEqual(Option.getOrThrow((yield* fs.stat(`${root}/a`)).atime).getTime(), 1234)
        }))
    }

    for (const destination of ["caller", "fileSystem"] as const) {
      it.effect(`should retain merged directory modes when ${destination} requires the enabled special-bit policy`, () =>
        Effect.gen(function*() {
          const caller = yield* (yield* Vfs.make()).caller()
          const fs = yield* MemoryFileSystem.bindCaller(caller)
          yield* fs.makeDirectory("/copy", { mode: 0o700 })
          const source = yield* Vfs.fromFixture({ ...FOUR_FILES_FIXTURE, rootMetadata: { mode: 0o1777 } })
          yield* (yield* source.caller()).chmod("/a", 0o4755)

          const options: TreeTransfer.WriteOptions = {
            existing: "overwrite",
            specialBits: true,
            required: { specialBits: true }
          }

          const sink = destination === "caller"
            ? TreeTransfer.toCaller(caller, "/copy", options)
            : TreeTransfer.toFileSystem(fs, "/copy", options)

          yield* Stream.run(TreeTransfer.fromSnapshot(yield* source.snapshot, "/"), sink)
          assert.strictEqual((yield* caller.stat("/copy")).mode, 0o700)
          assert.strictEqual((yield* caller.stat("/copy/a")).mode, 0o4755)
        }))
    }

    it.effect("should preserve required volume fidelity when owner and special bits are enabled", () =>
      Effect.gen(function*() {
        const source = yield* representativeTree
        yield* (yield* source.caller()).chown("/src/nested/data.bin", { uid: 123, gid: 456 })
        const expected = yield* snapshotEntries(source, "/src")

        const copy = yield* TreeTransfer.toVolume(
          TreeTransfer.fromSnapshot(yield* source.snapshot, "/src"),
          {
            owner: true,
            specialBits: true,
            required: { ...TreeTransfer.SinkCapabilities.volume, specialBits: true, times: "all" }
          }
        )

        assert.deepStrictEqual(yield* snapshotEntries(copy, "/"), expected)
      }))

    it.effect("should accept stronger volume capabilities when only millisecond precision and best-effort links are required", () =>
      Effect.gen(function*() {
        const source = yield* representativeTree

        const copy = yield* TreeTransfer.fromSnapshot(yield* source.snapshot, "/src").pipe(
          TreeTransfer.toVolume({
            required: { timestampPrecision: "millisecond", hardLinks: "bestEffort", owner: false }
          })
        )

        const caller = yield* copy.caller()
        assert.strictEqual((yield* caller.stat("/nested/data.bin")).mtimeNs, 32n)
        assert.strictEqual(yield* caller.lookup("/relative"), yield* caller.lookup("/relative-alias"))
      }))

    it.effect("should preserve byte names and exact hard links when caller fidelity is required", () =>
      Effect.gen(function*() {
        const source = yield* representativeTree
        const original = yield* source.caller()
        yield* original.chmod(Vfs.Target.Path({ path: "/src/relative", followFinalSymlink: false }), 0o540)
        const caller = yield* (yield* Vfs.make()).caller()

        const report = yield* Stream.run(
          TreeTransfer.fromSnapshot(yield* source.snapshot, "/src"),
          TreeTransfer.toCaller(caller, "/copy", {
            times: "all",
            specialBits: true,
            required: { ...TreeTransfer.SinkCapabilities.caller, specialBits: true, times: "all" }
          })
        )

        assert.strictEqual(report.hardLinksDegraded, 0)
        assert.strictEqual(
          (yield* caller.stat(Vfs.Target.Path({ path: "/copy/relative", followFinalSymlink: false }))).mode,
          0o540
        )
        assert.strictEqual(yield* caller.lookup("/copy/relative"), yield* caller.lookup("/copy/relative-alias"))
        const raw = yield* Vfs.pathFromBytes(new Uint8Array([...new TextEncoder().encode("/copy/raw-"), 0xff]))
        assert.deepStrictEqual(yield* caller.readFile(raw), new TextEncoder().encode("raw"))
        assert.strictEqual((yield* caller.stat("/copy/nested/data.bin")).mtimeNs, 32n)
      }))

    it.effect("should accept best-effort hard links and millisecond precision with matching FileSystem options", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem.pipe(Effect.provide(MemoryFileSystem.layer))
        const source = yield* Vfs.fromFixture(FOUR_FILES_FIXTURE)
        yield* (yield* source.caller()).utimes("/a", {
          access: { kind: "value", nanoseconds: 1_234_567_890n },
          modification: { kind: "value", nanoseconds: 5_678_901_234n }
        })

        const report = yield* Stream.run(
          TreeTransfer.fromSnapshot(yield* source.snapshot, "/").pipe(
            Stream.concat(Stream.fromIterable<TreeTransfer.Entry>([
              { kind: "symlink", path: "/link", target: "a" },
              { kind: "hardLink", path: "/alias", target: "/link" }
            ]))
          ),
          TreeTransfer.toFileSystem(fs, "/copy", {
            times: "all",
            required: { ...TreeTransfer.SinkCapabilities.fileSystem, times: "all" }
          })
        )

        assert.strictEqual(report.entries, 7)
        assert.strictEqual(report.hardLinksDegraded, 1)
        assert.strictEqual(yield* fs.readLink("/copy/alias"), "a")
        const stat = yield* fs.stat("/copy/a")
        assert.strictEqual(Option.getOrThrow(stat.mtime).getTime(), 5678)
        assert.strictEqual(Option.getOrThrow(stat.atime).getTime(), 1234)
        assert.deepStrictEqual(yield* fs.readDirectory("/copy"), ["a", "alias", "b", "c", "d", "link"])
      }))
  })
})

describe("Transfer cleanup", () => {
  const text = new TextEncoder()

  const cleanupDestination = Effect.fnUntraced(function*(
    kind: "Caller" | "Memory" | "Node",
    options?: {
      cleanupFails?: boolean
      metadataFails?: boolean
      writeFails?: boolean
      writing?: {
        started: Deferred.Deferred<void>
        resume: Deferred.Deferred<void>
        interrupted: Deferred.Deferred<void>
      }
      claiming?: { started: Deferred.Deferred<void>; resume: Deferred.Deferred<void> }
      finalizing?: { started: Deferred.Deferred<void>; resume: Deferred.Deferred<void> }
    }
  ) {
    let claimObserved = false

    const afterStat = Effect.fnUntraced(function*() {
      if (claimObserved || options?.claiming === undefined) return
      claimObserved = true
      yield* Deferred.succeed(options.claiming.started, undefined)
      yield* Deferred.await(options.claiming.resume)
    })

    const callerFailure = Object.assign(new Vfs.VfsError({ code: "AccessDenied", operation: "chmod" }), {
      code: "AccessDenied" as const
    })

    const metadataFailure = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "chmod"
    })

    const writeFailure = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "writeAll"
    })

    const writing = options?.writing

    const afterWrite = writing === undefined ? Effect.void : Effect.gen(function*() {
      yield* Deferred.succeed(writing.started, undefined)
      yield* Deferred.await(writing.resume)
    }).pipe(Effect.onInterrupt(() => Deferred.succeed(writing.interrupted, undefined)))

    const beforeMode = (mode: number) =>
      mode === 0o555 && options?.finalizing !== undefined
        ? Deferred.succeed(options.finalizing.started, undefined).pipe(
          Effect.andThen(Deferred.await(options.finalizing.resume))
        )
        : Effect.void

    if (kind === "Caller") {
      const volume = yield* Vfs.make()
      yield* (yield* volume.caller()).chmod("/", 0o777)
      const caller = yield* volume.caller({ identity: { uid: 1000, gid: 1000, groups: [], privileged: false } })

      return {
        fs: yield* MemoryFileSystem.bindCaller(caller),
        root: "/copy",
        sink: (existing: "reject" | "overwrite") =>
          TreeTransfer.toCaller(
            {
              ...caller,
              stat: (target) => caller.stat(target).pipe(Effect.tap(afterStat)),
              rmdir: (path) =>
                options?.cleanupFails
                  ? Effect.fail(
                    Object.assign(new Vfs.VfsError({ code: "AccessDenied", operation: "rmdir" }), {
                      code: "AccessDenied" as const
                    })
                  )
                  : caller.rmdir(path),
              chmod: Function.dual(2, (target: Vfs.TargetInput, mode: number) =>
                options?.metadataFails && mode === 0o540 ?
                  Effect.fail(callerFailure)
                  : beforeMode(mode).pipe(Effect.andThen(caller.chmod(target, mode))))
            },
            "/copy",
            { existing }
          )
      }
    }

    const fs = yield* FileSystem.FileSystem.pipe(
      Effect.provide(kind === "Node" ? NodeFileSystem.layer : MemoryFileSystem.layer)
    )

    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "transfer-cleanup-" })
    const root = `${directory}/copy`

    return {
      fs,
      root,
      sink: (existing: "reject" | "overwrite") =>
        TreeTransfer.toFileSystem(
          FileSystem.make({
            ...fs,
            stat: (path) => fs.stat(path).pipe(Effect.tap(afterStat)),
            open: (path, openOptions) =>
              fs.open(path, openOptions).pipe(Effect.map((file) => ({
                ...file,
                stat: file.stat.pipe(Effect.tap(afterStat)),
                writeAll: (contents: Uint8Array) =>
                  options?.writeFails
                    ? file.writeAll(contents.subarray(0, 1)).pipe(Effect.andThen(Effect.fail(writeFailure)))
                    : file.writeAll(contents).pipe(Effect.andThen(afterWrite))
              }))),
            writeFile: (path, contents, writeOptions) =>
              options?.writeFails
                ? fs.writeFile(path, contents.subarray(0, 1), writeOptions).pipe(
                  Effect.andThen(Effect.fail(metadataFailure))
                )
                : fs.writeFile(path, contents, writeOptions).pipe(Effect.andThen(afterWrite)),
            remove: (path, removeOptions) =>
              options?.cleanupFails
                ? Effect.fail(
                  PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "remove" })
                )
                : fs.remove(path, removeOptions),
            chmod: (path, mode) =>
              options?.metadataFails && mode === 0o540 ?
                Effect.fail(metadataFailure)
                : beforeMode(mode).pipe(Effect.andThen(fs.chmod(path, mode)))
          }),
          root,
          { existing }
        )
    }
  })

  for (const kind of ["Caller", "Memory", "Node"] as const) {
    it.layer(NodeCrypto.layer)(`TreeTransfer cleanup (${kind})`, (it) => {
      it.effect("should remove the created root when its initial metadata fails", () =>
        Effect.gen(function*() {
          const { fs, root, sink } = yield* cleanupDestination(kind, { metadataFails: true })

          const entry: TreeTransfer.Entry = kind === "Caller"
            ? { kind: "symlink", path: "/", target: "missing", metadata: { mode: 0o540 } }
            : { kind: "file", path: "/", bytes: text.encode("partial"), metadata: { mode: 0o540 } }

          const exit = yield* Effect.exit(Stream.run(Stream.make(entry), sink("reject")))
          assert.isTrue(Exit.isFailure(exit))

          if (Exit.isFailure(exit)) assert.isTrue(Cause.hasFails(exit.cause))
          const parent = root.slice(0, root.lastIndexOf("/")) || "/"
          assert.notInclude(yield* fs.readDirectory(parent), "copy")
          yield* fs.writeFileString(root, "usable")
          assert.strictEqual(yield* fs.readFileString(root), "usable")
        }))

      if (kind !== "Caller") {
        it.effect("should interrupt a blocked root-file write after ownership has been captured", () =>
          Effect.gen(function*() {
            const writing = {
              started: yield* Deferred.make<void>(),
              resume: yield* Deferred.make<void>(),
              interrupted: yield* Deferred.make<void>()
            }

            const { fs, root, sink } = yield* cleanupDestination(kind, { writing })

            const fiber = yield* Effect.forkChild(Stream.run(
              Stream.fromIterable<TreeTransfer.Entry>([
                { kind: "file", path: "/", bytes: text.encode("partial") }
              ]),
              sink("reject")
            ))

            yield* Deferred.await(writing.started)
            const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))
            yield* Effect.yieldNow
            const stoppedBeforeRelease = yield* Deferred.isDone(writing.interrupted)
            yield* Deferred.succeed(writing.resume, undefined)
            yield* Fiber.join(interrupting)
            const exit = yield* Fiber.await(fiber)
            assert.isTrue(stoppedBeforeRelease)
            assert.isTrue(Exit.isFailure(exit))

            if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterruptsOnly(exit.cause))
            assert.isFalse(yield* fs.exists(root))
          }))

        it.effect("should retain the handle identity when a root file is moved and replaced during its write", () =>
          Effect.gen(function*() {
            const writing = {
              started: yield* Deferred.make<void>(),
              resume: yield* Deferred.make<void>(),
              interrupted: yield* Deferred.make<void>()
            }

            const { fs, root, sink } = yield* cleanupDestination(kind, { writing, metadataFails: true })

            const fiber = yield* Effect.forkChild(Stream.run(
              Stream.fromIterable<TreeTransfer.Entry>([
                { kind: "file", path: "/", bytes: text.encode("original"), metadata: { mode: 0o540 } }
              ]),
              sink("reject")
            ))

            yield* Deferred.await(writing.started)
            yield* fs.rename(root, `${root}-moved`)
            yield* fs.writeFileString(root, "replacement")
            yield* Deferred.succeed(writing.resume, undefined)
            const exit = yield* Fiber.await(fiber)
            assert.isTrue(Exit.isFailure(exit))

            if (Exit.isFailure(exit)) assert.isTrue(Cause.hasFails(exit.cause))
            assert.strictEqual(yield* fs.readFileString(root), "replacement")
            assert.strictEqual(yield* fs.readFileString(`${root}-moved`), "original")
          }))

        for (const targetExists of [false, true]) {
          it.effect(`should finish an allowed root symlink when its target ${targetExists ? "exists" : "dangles"}`, () =>
            Effect.gen(function*() {
              const { fs, root } = yield* cleanupDestination(kind)
              const target = `${root}-target`

              if (targetExists) yield* fs.writeFileString(target, "protected")

              const report = yield* Stream.run(
                Stream.fromIterable<TreeTransfer.Entry>([
                  { kind: "symlink", path: "/", target }
                ]),
                TreeTransfer.toFileSystem(fs, root, { escaping: "allow" })
              )

              assert.strictEqual(report.entries, 1)
              assert.strictEqual(yield* fs.readLink(root), target)

              if (targetExists) assert.strictEqual(yield* fs.readFileString(target), "protected")
              else assert.isFalse(yield* fs.exists(root))
            }))
        }

        it.effect("should keep a finalized root symlink when interruption arrives during its creation", () =>
          Effect.gen(function*() {
            const { fs, root } = yield* cleanupDestination(kind)
            const created = yield* Deferred.make<void>()
            const resume = yield* Deferred.make<void>()

            const delayed = FileSystem.make({
              ...fs,
              symlink: (target, path) =>
                fs.symlink(target, path).pipe(
                  Effect.andThen(Deferred.succeed(created, undefined)),
                  Effect.andThen(Deferred.await(resume))
                )
            })

            const fiber = yield* Effect.forkChild(Stream.run(
              Stream.fromIterable<TreeTransfer.Entry>([
                { kind: "symlink", path: "/", target: "missing" }
              ]),
              TreeTransfer.toFileSystem(delayed, root, { escaping: "allow" })
            ))

            yield* Deferred.await(created)
            const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))
            yield* Effect.yieldNow
            yield* Deferred.succeed(resume, undefined)
            yield* Fiber.join(interrupting)
            const exit = yield* Fiber.await(fiber)
            assert.isTrue(Exit.isFailure(exit))

            if (Exit.isFailure(exit)) {
              assert.isTrue(Cause.hasInterruptsOnly(exit.cause))
            }

            assert.strictEqual(yield* fs.readLink(root), "missing")
          }))

        it.effect("should remove a root file when its contents fail after creation", () =>
          Effect.gen(function*() {
            const { fs, root, sink } = yield* cleanupDestination(kind, { writeFails: true })

            const exit = yield* Effect.exit(Stream.run(
              Stream.fromIterable<TreeTransfer.Entry>([
                { kind: "file", path: "/", bytes: text.encode("partial") }
              ]),
              sink("reject")
            ))

            assert.isTrue(Exit.isFailure(exit))

            if (Exit.isFailure(exit)) assert.isTrue(Cause.hasFails(exit.cause))
            assert.isFalse(yield* fs.exists(root))
            yield* fs.writeFileString(root, "usable")
            assert.strictEqual(yield* fs.readFileString(root), "usable")
          }))
      }

      for (
        const rootKind of kind === "Caller"
          ? ["directory", "file", "symlink"] as const
          : ["directory", "file"] as const
      ) {
        it.effect(`should remove a ${rootKind} root when interrupted while recording ownership`, () =>
          Effect.gen(function*() {
            const claiming = { started: yield* Deferred.make<void>(), resume: yield* Deferred.make<void>() }
            const { fs, root, sink } = yield* cleanupDestination(kind, { claiming })

            const entry: TreeTransfer.Entry = rootKind === "file"
              ? { kind: "file", path: "/", bytes: text.encode("partial") }
              : rootKind === "symlink"
              ? { kind: "symlink", path: "/", target: "missing" }
              : { kind: "directory", path: "/" }

            const fiber = yield* Effect.forkChild(Stream.run(Stream.make(entry), sink("reject")))
            yield* Deferred.await(claiming.started)
            const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))
            yield* Effect.yieldNow
            yield* Deferred.succeed(claiming.resume, undefined)
            yield* Fiber.join(interrupting)
            const exit = yield* Fiber.await(fiber)
            assert.isTrue(Exit.isFailure(exit))

            if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterrupts(exit.cause))
            const parent = root.slice(0, root.lastIndexOf("/")) || "/"
            assert.notInclude(yield* fs.readDirectory(parent), "copy")
          }))
      }

      for (const existing of ["reject", "overwrite"] as const) {
        for (const stop of ["interrupt", "timeout"] as const) {
          it.effect(`should finish ${existing} cleanup after ${stop} while waiting for another source entry`, () =>
            Effect.gen(function*() {
              const { fs, root, sink } = yield* cleanupDestination(kind, { cleanupFails: existing === "overwrite" })
              const source = yield* Vfs.fromFixture(FOUR_FILES_FIXTURE)
              const waiting = yield* Deferred.make<void>()

              const stream = TreeTransfer.fromSnapshot(yield* source.snapshot, "/").pipe(
                Stream.take(2),
                Stream.map((entry) =>
                  entry.kind === "directory"
                    ? { ...entry, metadata: { ...entry.metadata, mode: 0o555 } }
                    : entry
                ),
                Stream.concat(
                  Stream.fromEffect(Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never)))
                )
              )

              const transfer = Stream.run(stream, sink(existing))

              const fiber = yield* Effect.forkChild(
                stop === "timeout" ? transfer.pipe(Effect.timeout("1 second")) : transfer
              )

              yield* Deferred.await(waiting)
              assert.deepStrictEqual(yield* fs.readDirectory(root), ["a"])

              if (stop === "timeout") yield* TestClock.adjust("1 second")
              else yield* Fiber.interrupt(fiber)

              const exit = yield* Fiber.await(fiber)
              assert.isTrue(Exit.isFailure(exit))

              if (Exit.isFailure(exit)) {
                assert.isTrue(stop === "timeout" ? Cause.hasFails(exit.cause) : Cause.hasInterrupts(exit.cause))
                assert.isFalse(Cause.hasDies(exit.cause))
              }

              assert.strictEqual(yield* fs.exists(root), existing === "overwrite")

              if (existing === "overwrite") {
                assert.deepStrictEqual(yield* fs.readDirectory(root), ["a"])
                assert.strictEqual((yield* fs.stat(root)).mode & 0o777, 0o555)
                yield* fs.chmod(root, 0o755)
              } else yield* fs.makeDirectory(root)
              yield* fs.writeFileString(`${root}/after`, "usable")
              assert.strictEqual(yield* fs.readFileString(`${root}/after`), "usable")
            }))
        }
      }

      for (const stop of ["failure", "interrupt", "timeout"] as const) {
        it.effect(`should restore every created directory mode when overwrite stops by ${stop} with an unsearchable root`, () =>
          Effect.gen(function*() {
            const { fs, root, sink } = yield* cleanupDestination(kind)
            const waiting = yield* Deferred.make<void>()

            const stream = Stream.fromIterable<TreeTransfer.Entry>([
              { kind: "directory", path: "/", metadata: { mode: 0o000 } },
              { kind: "directory", path: "/nested", metadata: { mode: 0o000 } }
            ]).pipe(Stream.concat(Stream.fromEffect(Effect.gen(function*() {
              yield* Deferred.succeed(waiting, undefined)

              return yield* stop === "failure" ? Effect.fail("source failed") : Effect.never
            }))))

            const transfer = Stream.run(stream, sink("overwrite"))

            const fiber = yield* Effect.forkChild(
              stop === "timeout" ? transfer.pipe(Effect.timeout("1 second")) : transfer
            )

            yield* Deferred.await(waiting)

            if (stop === "interrupt") yield* Fiber.interrupt(fiber)

            if (stop === "timeout") yield* TestClock.adjust("1 second")
            const exit = yield* Fiber.await(fiber)
            assert.isTrue(Exit.isFailure(exit))

            if (Exit.isFailure(exit)) {
              assert.isFalse(Cause.hasDies(exit.cause))

              if (stop === "interrupt") assert.isTrue(Cause.hasInterrupts(exit.cause))
              else if (stop === "failure") {
                assert.deepStrictEqual(Cause.findError(exit.cause), Result.succeed("source failed"))
              } else assert.isTrue(Cause.hasFails(exit.cause))
            }

            assert.strictEqual((yield* fs.stat(root)).mode & 0o777, 0o000)
            yield* fs.chmod(root, 0o700)
            const nestedMode = (yield* fs.stat(`${root}/nested`)).mode & 0o777
            yield* fs.chmod(`${root}/nested`, 0o700)
            assert.strictEqual(nestedMode, 0o000)
            yield* fs.writeFileString(`${root}/nested/after`, "usable")
            assert.strictEqual(yield* fs.readFileString(`${root}/nested/after`), "usable")
          }))
      }

      for (const stop of ["failure", "interrupt"] as const) {
        it.effect(`should retain the original ${stop} and a cleanup defect when root removal fails`, () =>
          Effect.gen(function*() {
            const { fs, root, sink } = yield* cleanupDestination(kind, { cleanupFails: true })
            const waiting = yield* Deferred.make<void>()

            const stream = Stream.fromIterable<TreeTransfer.Entry>([
              { kind: "directory", path: "/" },
              { kind: "file", path: "/data", bytes: text.encode("partial") }
            ]).pipe(Stream.concat(Stream.fromEffect(Effect.gen(function*() {
              yield* Deferred.succeed(waiting, undefined)

              return yield* stop === "failure" ? Effect.fail("source failed") : Effect.never
            }))))

            const fiber = yield* Effect.forkChild(Stream.run(stream, sink("reject")))
            yield* Deferred.await(waiting)

            if (stop === "interrupt") yield* Fiber.interrupt(fiber)
            const exit = yield* Fiber.await(fiber)
            assert.isTrue(Exit.isFailure(exit))

            if (Exit.isFailure(exit)) {
              assert.isTrue(Cause.hasDies(exit.cause))

              if (stop === "interrupt") assert.isTrue(Cause.hasInterrupts(exit.cause))
              else {
                assert.isFalse(Cause.hasFails(exit.cause))
                assert.strictEqual(exit.cause.reasons.find(Cause.isDieReason)?.defect, "source failed")
              }

              const defects = exit.cause.reasons.filter(Cause.isDieReason)
              const cleanupDefects = stop === "failure" ? defects.slice(1) : defects
              assert.strictEqual(defects.length, stop === "failure" ? 2 : 1)
              assert.deepStrictEqual(
                cleanupDefects.map((reason) =>
                  kind === "Caller"
                    ? Schema.is(Vfs.VfsError)(reason.defect)
                    : PlatformError.isPlatformError(reason.defect)
                ),
                [true]
              )
            }

            assert.isTrue(yield* fs.exists(root))
            yield* fs.writeFileString(`${root}/after`, "usable")
            assert.strictEqual(yield* fs.readFileString(`${root}/after`), "usable")
          }))
      }

      for (const existing of ["reject", "overwrite"] as const) {
        it.effect(`should finish restrictive directory modes before ${existing} finalization accepts interruption`, () =>
          Effect.gen(function*() {
            const finalizing = { started: yield* Deferred.make<void>(), resume: yield* Deferred.make<void>() }
            const { fs, root, sink } = yield* cleanupDestination(kind, { finalizing })

            const stream = Stream.fromIterable<TreeTransfer.Entry>([
              { kind: "directory", path: "/", metadata: { mode: 0o555 } },
              { kind: "directory", path: "/nested", metadata: { mode: 0o555 } },
              { kind: "file", path: "/nested/data", bytes: text.encode("complete") }
            ])

            const fiber = yield* Effect.forkChild(Stream.run(stream, sink(existing)))
            yield* Deferred.await(finalizing.started)
            const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))
            yield* Effect.yieldNow
            yield* Deferred.succeed(finalizing.resume, undefined)
            yield* Fiber.join(interrupting)
            const exit = yield* Fiber.await(fiber)
            assert.isTrue(Exit.isFailure(exit))

            if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterrupts(exit.cause))
            assert.strictEqual((yield* fs.stat(root)).mode & 0o777, 0o555)
            assert.strictEqual((yield* fs.stat(`${root}/nested`)).mode & 0o777, 0o555)
            assert.strictEqual(yield* fs.readFileString(`${root}/nested/data`), "complete")
            yield* fs.chmod(root, 0o755)
            yield* fs.chmod(`${root}/nested`, 0o755)
            yield* fs.writeFileString(`${root}/nested/after`, "usable")
            assert.strictEqual(yield* fs.readFileString(`${root}/nested/after`), "usable")
          }))
      }

      for (const replacement of ["directory", "symlink"] as const) {
        it.effect(`should preserve a replacement ${replacement} and the moved claimed tree when the source fails`, () =>
          Effect.gen(function*() {
            const { fs, root, sink } = yield* cleanupDestination(kind)
            const source = yield* Vfs.fromFixture(FOUR_FILES_FIXTURE)
            const waiting = yield* Deferred.make<void>()
            const resume = yield* Deferred.make<void>()

            const stream = TreeTransfer.fromSnapshot(yield* source.snapshot, "/").pipe(
              Stream.take(2),
              Stream.concat(Stream.fromEffect(Effect.gen(function*() {
                yield* Deferred.succeed(waiting, undefined)
                yield* Deferred.await(resume)

                return yield* Effect.fail("source failed")
              })))
            )

            const fiber = yield* Effect.forkChild(Stream.run(stream, sink("reject")))
            yield* Deferred.await(waiting)
            yield* fs.rename(root, `${root}-moved`)
            const protectedRoot = replacement === "directory" ? root : `${root}-outside`
            yield* fs.makeDirectory(protectedRoot)
            yield* fs.writeFileString(`${protectedRoot}/keep`, "replacement")

            if (replacement === "symlink") yield* fs.symlink(protectedRoot, root)
            yield* Deferred.succeed(resume, undefined)
            const exit = yield* Fiber.await(fiber)
            assert.isTrue(Exit.isFailure(exit))

            if (Exit.isFailure(exit)) {
              assert.deepStrictEqual(Cause.findError(exit.cause), Result.succeed("source failed"))
            }

            assert.strictEqual(yield* fs.readFileString(`${protectedRoot}/keep`), "replacement")

            if (replacement === "symlink") assert.strictEqual(yield* fs.readLink(root), protectedRoot)
            assert.deepStrictEqual(yield* fs.readDirectory(`${root}-moved`), ["a"])
            yield* fs.writeFileString(`${root}-moved/after`, "usable")
            assert.strictEqual(yield* fs.readFileString(`${root}-moved/after`), "usable")
          }))
      }
    })
  }

  it.layer(NodeCrypto.layer)("TreeTransfer confined cleanup", (it) => {
    it.effect("should write a read-only root file through an unprivileged FileSystem binding", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.make()
        yield* (yield* volume.caller()).chmod("/", 0o777)
        const caller = yield* volume.caller({ identity: { uid: 1000, gid: 1000, groups: [], privileged: false } })
        const fs = yield* MemoryFileSystem.bindCaller(caller)
        yield* Stream.run(
          Stream.fromIterable<TreeTransfer.Entry>([
            { kind: "file", path: "/", bytes: text.encode("readable"), metadata: { mode: 0o444 } }
          ]),
          TreeTransfer.toFileSystem(fs, "/copy")
        )
        assert.strictEqual((yield* caller.stat("/copy")).mode, 0o444)
        assert.strictEqual(yield* fs.readFileString("/copy"), "readable")
      }))

    it.effect("should preserve outside state when a confined destination moves outside and is replaced by a symlink", () =>
      Effect.gen(function*() {
        const admin = yield* (yield* Vfs.make()).caller()
        yield* admin.mkdir("/jail")
        yield* admin.mkdir("/outside")
        yield* admin.writeFile("/outside/keep", text.encode("protected"), { create: "exclusive", access: "write" })
        const confined = yield* admin.withRoot("/jail")
        const waiting = yield* Deferred.make<void>()
        const resume = yield* Deferred.make<void>()

        const stream = Stream.fromIterable<TreeTransfer.Entry>([
          { kind: "directory", path: "/" },
          { kind: "file", path: "/data", bytes: text.encode("partial") }
        ]).pipe(Stream.concat(Stream.fromEffect(Effect.gen(function*() {
          yield* Deferred.succeed(waiting, undefined)
          yield* Deferred.await(resume)

          return yield* Effect.fail("source failed")
        }))))

        const fiber = yield* Effect.forkChild(Stream.run(stream, TreeTransfer.toCaller(confined, "/copy")))
        yield* Deferred.await(waiting)
        yield* admin.rename("/jail/copy", "/outside/moved")
        yield* admin.symlink("/outside", "/jail/copy")
        yield* Deferred.succeed(resume, undefined)
        const exit = yield* Fiber.await(fiber)
        assert.isTrue(Exit.isFailure(exit))

        if (Exit.isFailure(exit)) assert.deepStrictEqual(Cause.findError(exit.cause), Result.succeed("source failed"))
        assert.deepStrictEqual(yield* admin.readFile("/outside/keep"), text.encode("protected"))
        assert.deepStrictEqual(yield* admin.readFile("/outside/moved/data"), text.encode("partial"))
        assert.deepStrictEqual(yield* confined.readLink("/copy"), text.encode("/outside"))
        assert.strictEqual((yield* Effect.flip(confined.readFile("/copy/keep"))).code, "NotFound")
        yield* admin.writeFile("/outside/moved/after", text.encode("usable"), { create: "exclusive", access: "write" })
        assert.deepStrictEqual(yield* admin.readFile("/outside/moved/after"), text.encode("usable"))
      }))
  })
})

describe("Source and sink call styles", () => {
  const fixture: Vfs.Fixture = { entries: [{ kind: "file", path: "/file", bytes: Uint8Array.of(7) }] }

  const entries = Stream.fromIterable<TreeTransfer.Entry>([
    { kind: "directory", path: "/" },
    { kind: "file", path: "/file", bytes: Uint8Array.of(7) }
  ])

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should stream the selected tree when caller, snapshot, and filesystem sources use either call style", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.fromFixture(fixture)
        const caller = yield* volume.caller()
        const snapshot = yield* volume.snapshot
        const fs = yield* MemoryFileSystem.bind(volume)

        const options: TreeTransfer.ReadOptions = {
          limits: { ...TreeTransfer.TreeTransferLimits.default, maxEntries: 10 }
        }

        const sources: Array<
          Stream.Stream<TreeTransfer.Entry, TreeTransfer.TransferError | Vfs.VfsError | PlatformError.PlatformError>
        > = [
          TreeTransfer.fromCaller(caller, "/"),
          TreeTransfer.fromCaller(caller, "/", undefined),
          TreeTransfer.fromCaller(caller, "/", options),
          TreeTransfer.fromCaller("/")(caller),
          TreeTransfer.fromCaller("/", undefined)(caller),
          TreeTransfer.fromCaller("/", options)(caller),
          TreeTransfer.fromSnapshot(snapshot, "/"),
          TreeTransfer.fromSnapshot(snapshot, "/", undefined),
          TreeTransfer.fromSnapshot(snapshot, "/", options),
          TreeTransfer.fromSnapshot("/")(snapshot),
          TreeTransfer.fromSnapshot("/", undefined)(snapshot),
          TreeTransfer.fromSnapshot("/", options)(snapshot),
          TreeTransfer.fromFileSystem(fs, "/"),
          TreeTransfer.fromFileSystem(fs, "/", undefined),
          TreeTransfer.fromFileSystem(fs, "/", options),
          TreeTransfer.fromFileSystem("/")(fs),
          TreeTransfer.fromFileSystem("/", undefined)(fs),
          TreeTransfer.fromFileSystem("/", options)(fs)
        ]

        for (const source of sources) {
          const rows = yield* Stream.runCollect(source)
          assert.deepStrictEqual(rows.map((row) => row.path), ["/", "/file"])
          assert.deepStrictEqual(rows.find((row) => row.kind === "file")?.bytes, Uint8Array.of(7))
        }

        const root = yield* Vfs.pathFromBytes(Uint8Array.of(47))
        assert.deepStrictEqual(
          (yield* Stream.runCollect(TreeTransfer.fromCaller(root)(caller))).map((row) => row.path),
          ["/", "/file"]
        )
        const invalidRoot = "/missing"
        assert.deepStrictEqual(
          yield* Effect.flip(Stream.runCollect(TreeTransfer.fromSnapshot(invalidRoot)(snapshot))),
          yield* Effect.flip(Stream.runCollect(TreeTransfer.fromSnapshot(snapshot, invalidRoot)))
        )
      }))

    it.effect("should write the selected destination when caller and filesystem sinks use either call style", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.make()
        const caller = yield* volume.caller()
        const fs = yield* MemoryFileSystem.bind(volume)
        const options: TreeTransfer.WriteOptions = { times: "none" }

        const sinks = [
          TreeTransfer.toCaller(caller, "/caller-direct"),
          TreeTransfer.toCaller(caller, "/caller-undefined", undefined),
          TreeTransfer.toCaller(caller, "/caller-options", options),
          TreeTransfer.toCaller("/caller-curried")(caller),
          TreeTransfer.toCaller("/caller-curried-undefined", undefined)(caller),
          TreeTransfer.toCaller("/caller-curried-options", options)(caller),
          TreeTransfer.toFileSystem(fs, "/fs-direct"),
          TreeTransfer.toFileSystem(fs, "/fs-undefined", undefined),
          TreeTransfer.toFileSystem(fs, "/fs-options", options),
          TreeTransfer.toFileSystem("/fs-curried")(fs),
          TreeTransfer.toFileSystem("/fs-curried-undefined", undefined)(fs),
          TreeTransfer.toFileSystem("/fs-curried-options", options)(fs)
        ]

        for (const sink of sinks) {
          const report = yield* entries.pipe(Stream.run(sink))
          assert.strictEqual(report.entries, 2)
        }

        const destinations = yield* caller.readDirectory("/")
        assert.strictEqual(destinations.value.length, sinks.length)

        for (const entry of destinations.value) {
          const name = new TextDecoder().decode(entry.name)
          assert.deepStrictEqual(yield* caller.readFile(`/${name}/file`), Uint8Array.of(7))
        }
      }))
  })
})

describe("Import call styles", () => {
  it.layer(NodeCrypto.layer)((it) => {
    it.effect("imports streams with omitted, undefined, or explicit options in either call style", () =>
      Effect.gen(function*() {
        const entries = Stream.fromIterable<TreeTransfer.Entry>([
          { kind: "directory", path: "/" },
          { kind: "file", path: "/file", bytes: Uint8Array.of(7), metadata: { mode: 0o4755 } }
        ])

        const imports = [
          TreeTransfer.toVolume(entries),
          TreeTransfer.toVolume(entries, undefined),
          entries.pipe(TreeTransfer.toVolume()),
          entries.pipe(TreeTransfer.toVolume(undefined)),
          TreeTransfer.toVolume(entries, { specialBits: true }),
          entries.pipe(TreeTransfer.toVolume({ specialBits: true }))
        ]

        for (const [index, operation] of imports.entries()) {
          const volume = yield* operation
          const caller = yield* volume.caller()
          assert.deepStrictEqual(yield* caller.readFile("/file"), Uint8Array.of(7))
          assert.strictEqual((yield* caller.stat("/file")).mode, index >= 4 ? 0o4755 : 0o755)
        }

        assert.strictEqual(
          yield* Effect.flip(Stream.fail("source failed").pipe(TreeTransfer.toVolume())),
          "source failed"
        )
      }))
  })
})

describe("Host inode fidelity", () => {
  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should preserve distinct large host identities and bigint hard-link counts", () =>
      Effect.gen(function*() {
        const fs = yield* MemoryFileSystem.make
        yield* fs.makeDirectory("/source")

        for (const [name, data] of [["a", "first"], ["b", "second"], ["c", "first"]] as const) {
          yield* fs.writeFileString(`/source/${name}`, data)
        }

        const host = {
          ...fs,
          lstat: (path: string) =>
            Effect.map(fs.lstat(path), (value) =>
              value.type !== "File" ? value : ({
                ...value,
                dev: 9007199254740993n,
                ino: Option.some(path.endsWith("/b") ? 9007199254740993n : 9007199254740992n),
                nlink: Option.some(9007199254740999n)
              }))
        }

        const entries = yield* Stream.runCollect(TreeTransfer.fromFileSystem(host, "/source"))
        assert.deepStrictEqual(entries.map((entry) => [entry.kind, entry.path]), [["directory", "/"], ["file", "/a"], [
          "file",
          "/b"
        ], ["hardLink", "/c"]])
        const linked = entries.find((entry) => entry.kind === "hardLink")
        assert.strictEqual(linked?.target, "/a")
      }))
  })
})

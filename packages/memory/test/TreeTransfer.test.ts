import { Testing, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect, Exit, FileSystem, Layer, Predicate, Result, Schema, Stream } from "effect"
import * as TreeTransfer from "../src/TreeTransfer.js"
import { snapshotEntries } from "./support/snapshotEntries.js"

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

const FOUR_FILES_FIXTURE: Vfs.Fixture = {
  entries: ["a", "b", "c", "d"].map((name) => ({ kind: "file", path: `/${name}`, bytes: new Uint8Array() }))
}

const representativeTree = Effect.gen(function*() {
  const invalidName = yield* Vfs.pathFromBytes(new Uint8Array([...text.encode("/src/raw-"), 0xff]))

  return yield* Vfs.fromFixture({
    entries: [
      { kind: "directory", path: "/src", metadata: { mode: 0o750, atimeNs: 11n, mtimeNs: 12n, ctimeNs: 13n } },
      { kind: "directory", path: "/src/nested", metadata: { mode: 0o555, mtimeNs: 21n } },
      {
        kind: "file",
        path: "/src/nested/data.bin",
        bytes: new Uint8Array([0, 255, 1, 254]),
        metadata: { mode: 0o4755, atimeNs: 31n, mtimeNs: 32n, birthtimeNs: 33n }
      },
      { kind: "hardLink", path: "/src/alias.bin", target: "/src/nested/data.bin" },
      { kind: "symlink", path: "/src/relative", target: "nested/data.bin" },
      { kind: "symlink", path: "/src/dangling", target: "missing" },
      { kind: "symlink", path: "/src/escaping", target: "/etc/passwd" },
      { kind: "hardLink", path: "/src/relative-alias", target: "/src/relative" },
      { kind: "file", path: invalidName, bytes: text.encode("raw"), metadata: { mode: 0o600, mtimeNs: 41n } }
    ]
  })
})

const failure = <E>(error: E) => error instanceof TreeTransfer.TransferError ? [error.code, error.field] : error

const withoutChangeTimes = (entries: ReadonlyArray<TreeTransfer.Entry>) =>
  entries.map((entry) => {
    if (entry.kind === "hardLink" || entry.metadata === undefined) return entry
    const { ctimeNs: _ctime, birthtimeNs: _birthtime, ...metadata } = entry.metadata

    return { ...entry, metadata }
  })

describe("TreeTransfer", () => {
  it.layer(NodeCrypto.layer)((it) => {
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

        const volume = yield* TreeTransfer.toVolume(TreeTransfer.fromSnapshot(yield* source.snapshot, "/src"), {
          owner: true,
          specialBits: true
        })

        assert.deepStrictEqual(yield* snapshotEntries(volume, "/"), expected)
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

        const volume = yield* TreeTransfer.toVolume(
          TreeTransfer.fromSnapshot(yield* source.snapshot, "/src").pipe(
            Stream.filter((entry) => !Predicate.isString(entry.path) || !entry.path.startsWith("/nested"))
          )
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
    it.effect("should record the original access time when a newer live read follows the last change", () =>
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
    it.effect("should report a missing root when its entry path is malformed", () =>
      Effect.gen(function*() {
        const error = yield* Effect.flip(
          TreeTransfer.toVolume(Stream.make({ kind: "directory", path: "\uD800" } as const))
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
      ["a path repeats", [{ kind: "directory", path: "/a" }, { kind: "directory", path: "/a" }], "path"],
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

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should pass at a limit and fail below it when the same tree is transferred", () =>
      Effect.gen(function*() {
        const source = yield* representativeTree
        const snapshot = yield* source.snapshot

        const drain = (limits: Partial<TreeTransfer.TreeTransferLimits>) =>
          Effect.exit(Stream.runDrain(
            TreeTransfer.fromSnapshot(snapshot, "/src", {
              limits: { ...TreeTransfer.TreeTransferLimits.default, ...limits }
            })
          ))

        assert.isTrue(Exit.isSuccess(yield* drain({ maxEntries: 9 })))
        assert.isTrue(Exit.isFailure(yield* drain({ maxEntries: 8 })))
        assert.isTrue(Exit.isSuccess(yield* drain({ maxPathBytes: ByteSize.bytes(16) })))
        assert.isTrue(Exit.isFailure(yield* drain({ maxPathBytes: ByteSize.bytes(15) })))
      }))
  })

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
    it.effect("should preserve a replacement destination when a transfer fails", () =>
      Effect.gen(function*() {
        const destination = yield* Vfs.Caller

        const replace = Effect.gen(function*() {
          yield* destination.rename("/copy", "/moved")
          yield* destination.mkdir("/copy")
          yield* destination.writeFile("/copy/theirs", text.encode("keep"), { access: "write", create: "exclusive" })
        })

        const failing = Stream.fromIterable<TreeTransfer.Entry>([{ kind: "directory", path: "/" }]).pipe(
          Stream.concat(Stream.fromEffect(replace).pipe(Stream.drain)),
          Stream.concat(Stream.fail("source failed"))
        )

        yield* Effect.exit(Stream.run(failing, TreeTransfer.toCaller(destination, "/copy")))

        assert.deepStrictEqual(entryNames(yield* destination.readDirectory("/copy")), ["theirs"])
      }).pipe(Effect.provide(Testing.layer())))
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

it.layer(NodeFileSystem.layer.pipe(Layer.provideMerge(NodeCrypto.layer)))("TreeTransfer host FileSystem", (it) => {
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

  it.effect("should resolve escape checks when links remain inside the tree", () =>
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

        yield* Stream.run(Stream.fromIterable(inside), TreeTransfer.toFileSystem(fs, `${directory}/inside`))

        const error = yield* Effect.flip(
          Stream.run(Stream.fromIterable(outside), TreeTransfer.toFileSystem(fs, `${directory}/outside`))
        )

        assert.strictEqual(yield* fs.readLink(`${directory}/inside/ok`), "dir/up/dir")
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

  it.effect("should fail or report a non-UTF-8 name when the host cannot carry it", () =>
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

        const report = yield* Stream.run(
          Stream.fromIterable(entries),
          TreeTransfer.toFileSystem(fs, `${directory}/lenient`, { unsupported: "skip" })
        )

        assert.deepStrictEqual(hostFailure(error), ["UnrepresentableName", raw])
        assert.deepStrictEqual(report.skipped, [{ path: raw, reason: "UnrepresentableName" }])
        assert.deepStrictEqual(yield* fs.readDirectory(`${directory}/lenient`), ["plain"])
      })
    ))

  it.effect("should report a name collision when it occurs inside a claimed destination", () =>
    withTemp((fs, directory) =>
      Effect.gen(function*() {
        const entries: ReadonlyArray<TreeTransfer.Entry> = [
          { kind: "directory", path: "/" },
          { kind: "file", path: "/name", bytes: text.encode("first") },
          { kind: "file", path: "/name", bytes: text.encode("second") }
        ]

        const report = yield* Stream.run(
          Stream.fromIterable(entries),
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

  it.effect("should fail or skip an entry when the host reports it as a FIFO", () =>
    withTemp((fs, directory) =>
      Effect.gen(function*() {
        yield* fs.makeDirectory(`${directory}/tree`)
        yield* fs.writeFileString(`${directory}/tree/file`, "x")
        yield* fs.writeFileString(`${directory}/tree/pipe`, "never read")
        const skipped: Array<TreeTransfer.SkippedEntry> = []

        // Reports one regular file as a FIFO, so the adapter must classify it by type and never read it.
        const withFifo: FileSystem.FileSystem = {
          ...fs,
          stat: (path) =>
            fs.stat(path).pipe(Effect.map((info) => path.endsWith("/pipe") ? { ...info, type: "FIFO" as const } : info))
        }

        const error = yield* Effect.flip(Stream.runDrain(TreeTransfer.fromFileSystem(withFifo, `${directory}/tree`)))

        const entries = yield* Stream.runCollect(
          TreeTransfer.fromFileSystem(withFifo, `${directory}/tree`, {
            unsupported: "skip",
            onSkip: (entry) => Effect.sync(() => skipped.push(entry))
          })
        )

        assert.deepStrictEqual(hostFailure(error), ["UnsupportedEntryType", "/pipe"])
        assert.deepStrictEqual(entries.map((entry) => entry.path), ["/", "/file"])
        assert.deepStrictEqual(skipped, [{ path: "/pipe", reason: "UnsupportedEntryType" }])
      })
    ))

  it.effect("should fail before reading a host file when it exceeds the byte limit", () =>
    withTemp((fs, directory) =>
      Effect.gen(function*() {
        yield* fs.writeFile(`${directory}/large`, new Uint8Array(1024))
        const limits = { ...TreeTransfer.TreeTransferLimits.default, maxFileBytes: ByteSize.bytes(16) }

        const error = yield* Effect.flip(
          Stream.runDrain(TreeTransfer.fromFileSystem(fs, `${directory}/large`, { limits }))
        )

        assert.deepStrictEqual(hostFailure(error), ["LimitExceeded", "/"])
      })
    ))

  it.effect("should reject a link when it escapes through a folded name", () =>
    withTemp((fs, directory) =>
      Effect.gen(function*() {
        const entries: ReadonlyArray<TreeTransfer.Entry> = [
          { kind: "directory", path: "/" },
          { kind: "directory", path: "/d" },
          { kind: "symlink", path: "/d/L", target: ".." },
          { kind: "symlink", path: "/m", target: "d/l/../SECRET" }
        ]

        const error = yield* Effect.flip(
          Stream.run(Stream.fromIterable(entries), TreeTransfer.toFileSystem(fs, `${directory}/export`))
        )

        assert.deepStrictEqual(hostFailure(error), ["EscapingSymlink", "/m"])
        assert.isFalse(yield* fs.exists(`${directory}/export`))
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

  it.effect("should not write through a link when it replaces an overwritten entry", () =>
    withTemp((fs, directory) =>
      Effect.gen(function*() {
        yield* fs.writeFileString(`${directory}/outside`, "untouched")
        yield* fs.chmod(`${directory}/outside`, 0o600)
        yield* fs.makeDirectory(`${directory}/export`)
        yield* fs.writeFileString(`${directory}/export/file`, "old")

        // Models another process replacing the name with a link between the removal and the write.
        const racing: FileSystem.FileSystem = {
          ...fs,
          remove: (path, options) =>
            fs.remove(path, options).pipe(
              Effect.andThen(path.endsWith("/export/file") ? fs.symlink(`${directory}/outside`, path) : Effect.void)
            )
        }

        const entries: ReadonlyArray<TreeTransfer.Entry> = [
          { kind: "directory", path: "/" },
          { kind: "file", path: "/file", bytes: text.encode("copied"), metadata: { mode: 0o777 } }
        ]

        yield* Effect.exit(
          Stream.run(
            Stream.fromIterable(entries),
            TreeTransfer.toFileSystem(racing, `${directory}/export`, { existing: "overwrite" })
          )
        )

        assert.strictEqual(yield* fs.readFileString(`${directory}/outside`), "untouched")
        assert.strictEqual((yield* fs.stat(`${directory}/outside`)).mode & 0o777, 0o600)
      })
    ))

  it.effect("should report a hard-link collision when a destination name already exists", () =>
    withTemp((fs, directory) =>
      Effect.gen(function*() {
        const entries: ReadonlyArray<TreeTransfer.Entry> = [
          { kind: "directory", path: "/" },
          { kind: "file", path: "/a", bytes: text.encode("A") },
          { kind: "file", path: "/b", bytes: text.encode("B") },
          { kind: "hardLink", path: "/b", target: "/a" }
        ]

        const report = yield* Stream.run(
          Stream.fromIterable(entries),
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
          { kind: "file", path: "/b", bytes: text.encode("B") },
          { kind: "hardLink", path: "/b", target: "/a" }
        ]

        const error = yield* Effect.flip(
          Stream.run(Stream.fromIterable(entries), TreeTransfer.toFileSystem(fs, `${directory}/export`))
        )

        assert.deepStrictEqual(hostFailure(error), ["NameCollision", "/b"])
      })
    ))

  it.effect("should preserve a link target when a hard link is rewritten as a symbolic link", () =>
    withTemp((fs, directory) =>
      Effect.gen(function*() {
        const entries: ReadonlyArray<TreeTransfer.Entry> = [
          { kind: "directory", path: "/" },
          { kind: "directory", path: "/a" },
          { kind: "symlink", path: "/a/l", target: "../x" },
          { kind: "directory", path: "/b" },
          { kind: "directory", path: "/b/c" },
          { kind: "hardLink", path: "/b/c/l2", target: "/a/l" },
          { kind: "file", path: "/x", bytes: text.encode("target") }
        ]

        const report = yield* Stream.run(
          Stream.fromIterable(entries),
          TreeTransfer.toFileSystem(fs, `${directory}/export`)
        )

        assert.strictEqual(report.hardLinksDegraded, 1)
        assert.strictEqual(yield* fs.readLink(`${directory}/export/b/c/l2`), "../../x")
        assert.strictEqual(yield* fs.readFileString(`${directory}/export/b/c/l2`), "target")
      })
    ))

  it.effect("should apply exact modes when the host umask differs", () =>
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
          { kind: "file", path: "/d/x", bytes: text.encode("x") },
          { kind: "directory", path: "/d" },
          { kind: "file", path: "/d/y", bytes: text.encode("y") }
        ]

        const report = yield* Stream.run(
          Stream.fromIterable(entries),
          TreeTransfer.toFileSystem(fs, `${directory}/export`, { unsupported: "skip" })
        )

        assert.deepStrictEqual(report.skipped, [
          { path: "/d", reason: "NameCollision" },
          { path: "/d/y", reason: "NameCollision" }
        ])
        assert.deepStrictEqual(yield* fs.readDirectory(`${directory}/export/d`), ["x"])
      })
    ))

  it.effect("should fail or skip a host name when it is not valid UTF-8", () =>
    withTemp((fs, directory) =>
      Effect.gen(function*() {
        yield* fs.makeDirectory(`${directory}/tree`)
        yield* fs.writeFileString(`${directory}/tree/file`, "x")

        // Effect's FileSystem decodes names as UTF-8, so an undecodable host name arrives with U+FFFD.
        const lossy: FileSystem.FileSystem = {
          ...fs,
          readDirectory: (path, options) =>
            fs.readDirectory(path, options).pipe(Effect.map((names) => [...names, "bad\uFFFD"]))
        }

        const error = yield* Effect.flip(Stream.runDrain(TreeTransfer.fromFileSystem(lossy, `${directory}/tree`)))

        const entries = yield* Stream.runCollect(
          TreeTransfer.fromFileSystem(lossy, `${directory}/tree`, { unsupported: "skip", onSkip: () => Effect.void })
        )

        assert.deepStrictEqual(hostFailure(error), ["UnrepresentableName", "/bad\uFFFD"])
        assert.deepStrictEqual(entries.map((entry) => entry.path), ["/", "/file"])
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

  it.effect("should reject a host transfer when its source stream is empty", () =>
    withTemp((fs, directory) =>
      Effect.gen(function*() {
        const error = yield* Effect.flip(Stream.run(Stream.empty, TreeTransfer.toFileSystem(fs, `${directory}/export`)))

        assert.deepStrictEqual(hostFailure(error), ["InvalidEntry", undefined])
      })
    ))
})

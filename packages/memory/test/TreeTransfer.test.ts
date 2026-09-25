import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { assert, it } from "@effect/vitest"
import { ByteSize, Effect, Exit, Layer, Predicate, Schema, Stream } from "effect"
import * as TreeTransfer from "../src/TreeTransfer.js"

const entryNames = (listing: Vfs.ObjectObservation<ReadonlyArray<Vfs.DirectoryEntry>>) =>
  listing.value.map((entry) => new TextDecoder().decode(entry.name))

const text = new TextEncoder()

const OWNER = { uid: 1000, gid: 1000, groups: [], privileged: false }

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

const snapshotEntries = (volume: Vfs.Volume, root: string) =>
  Effect.flatMap(volume.snapshot, (snapshot) => Stream.runCollect(TreeTransfer.fromSnapshot(snapshot, root)))

const failure = <E>(error: E) => error instanceof TreeTransfer.TransferError ? [error.code, error.field] : error

const withoutChangeTimes = (entries: ReadonlyArray<TreeTransfer.Entry>) =>
  entries.map((entry) => {
    if (entry.kind === "hardLink" || entry.metadata === undefined) return entry
    const { ctimeNs: _ctime, birthtimeNs: _birthtime, ...metadata } = entry.metadata

    return { ...entry, metadata }
  })

it.layer(Layer.empty)("TreeTransfer", (it) => {
  it.effect("should round-trip a representative tree between callers when all metadata is requested", () =>
    Effect.gen(function*() {
      const source = yield* representativeTree
      const destination = yield* Vfs.make()
      const expected = yield* snapshotEntries(source, "/src")

      const report = yield* Stream.run(
        TreeTransfer.fromSnapshot(yield* source.snapshot, "/src"),
        TreeTransfer.toCaller(yield* destination.caller(), "/copy", { times: "all", specialBits: true })
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
    }))

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

  it.effect("should apply mtime and strip special bits when writing with default options", () =>
    Effect.gen(function*() {
      const source = yield* representativeTree
      const destination = yield* (yield* Vfs.make()).caller()

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
    }))

  it.effect("should write children of a read-only directory when the destination caller is unprivileged", () =>
    Effect.gen(function*() {
      const source = yield* representativeTree

      const volume = yield* Vfs.fromFixture({
        entries: [{ kind: "directory", path: "/home", metadata: { uid: OWNER.uid, gid: OWNER.gid } }]
      })

      const owner = yield* volume.caller({ identity: OWNER })

      yield* Stream.run(
        TreeTransfer.fromSnapshot(yield* source.snapshot, "/src"),
        TreeTransfer.toCaller(owner, "/home/copy")
      )

      assert.deepStrictEqual(entryNames(yield* owner.readDirectory("/home/copy/nested")), ["data.bin"])
      assert.strictEqual(
        (yield* owner.stat(Vfs.Target.Path({ path: "/home/copy/nested", followFinalSymlink: false }))).mode,
        0o555
      )
    }))

  it.effect("should leave an existing destination untouched when existing entries are rejected", () =>
    Effect.gen(function*() {
      const source = yield* representativeTree
      const destination = yield* (yield* Vfs.make()).caller()
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
    }))

  it.effect("should merge into and replace existing entries when overwriting", () =>
    Effect.gen(function*() {
      const source = yield* representativeTree
      const destination = yield* (yield* Vfs.make()).caller()
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
    }))

  it.effect("should remove a claimed destination when the source fails mid-transfer", () =>
    Effect.gen(function*() {
      const source = yield* representativeTree
      const destination = yield* (yield* Vfs.make()).caller()

      const failing = TreeTransfer.fromSnapshot(yield* source.snapshot, "/src").pipe(
        Stream.take(3),
        Stream.concat(Stream.fail("source failed"))
      )

      const exit = yield* Effect.exit(Stream.run(failing, TreeTransfer.toCaller(destination, "/copy")))

      assert.isTrue(Exit.isFailure(exit))
      assert.deepStrictEqual(entryNames(yield* destination.readDirectory("/")), [])
    }))

  it.effect("should keep written entries when an overwriting transfer fails", () =>
    Effect.gen(function*() {
      const source = yield* representativeTree
      const destination = yield* (yield* Vfs.make()).caller()

      const failing = TreeTransfer.fromSnapshot(yield* source.snapshot, "/src").pipe(
        Stream.take(2),
        Stream.concat(Stream.fail("source failed"))
      )

      yield* Effect.exit(Stream.run(failing, TreeTransfer.toCaller(destination, "/copy", { existing: "overwrite" })))

      assert.deepStrictEqual(entryNames(yield* destination.readDirectory("/copy")), ["alias.bin"])
    }))

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

  for (
    const [field, limits] of [
      ["maxEntries", { maxEntries: 3 }],
      ["maxDepth", { maxDepth: 1 }],
      ["maxFileBytes", { maxFileBytes: ByteSize.bytes(3) }],
      ["maxBytes", { maxBytes: ByteSize.bytes(5) }],
      ["maxPathBytes", { maxPathBytes: ByteSize.bytes(8) }]
    ] as const
  ) {
    it.effect(`should fail with the exceeded field when a source passes ${field}`, () =>
      Effect.gen(function*() {
        const source = yield* representativeTree

        const stream = TreeTransfer.fromSnapshot(yield* source.snapshot, "/src", {
          limits: { ...TreeTransfer.TreeTransferLimits.default, ...limits }
        })

        const error = yield* Effect.flip(Stream.runDrain(stream))

        assert.deepStrictEqual(failure(error), ["LimitExceeded", field])
      }))
  }

  it.effect("should reject a malformed limits policy", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const limits = { ...TreeTransfer.TreeTransferLimits.default, maxEntries: -1 }

      const error = yield* Effect.flip(Stream.runDrain(TreeTransfer.fromCaller(caller, "/", { limits })))

      assert.deepStrictEqual(failure(error), ["InvalidArgument", "limits"])
    }))

  it.effect("should record the original access time while live reads update the source", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.fromFixture({
        entries: [{ kind: "file", path: "/file", bytes: text.encode("x"), metadata: { atimeNs: 5n } }]
      })

      const caller = yield* volume.caller()

      const [entry] = yield* Stream.runCollect(TreeTransfer.fromCaller(caller, "/file"))

      assert.strictEqual(entry?.kind === "file" && entry.metadata?.atimeNs, 5n)
      assert.notStrictEqual(
        (yield* caller.stat(Vfs.Target.Path({ path: "/file", followFinalSymlink: false }))).atimeNs,
        5n
      )
    }))

  it.effect("should leave the source unchanged when streaming from a snapshot", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.fromFixture({
        entries: [{ kind: "file", path: "/file", bytes: text.encode("x"), metadata: { atimeNs: 5n } }]
      })

      yield* Stream.runDrain(TreeTransfer.fromSnapshot(yield* volume.snapshot, "/file"))

      assert.strictEqual(
        (yield* (yield* volume.caller()).stat(Vfs.Target.Path({ path: "/file", followFinalSymlink: false }))).atimeNs,
        5n
      )
    }))

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
    it.effect(`should reject the stream when ${name}`, () =>
      Effect.gen(function*() {
        const destination = yield* (yield* Vfs.make()).caller()

        const error = yield* Effect.flip(
          Stream.run(Stream.fromIterable(entries), TreeTransfer.toCaller(destination, "/copy"))
        )

        assert.deepStrictEqual(failure(error), ["InvalidEntry", field])
      }))
  }

  it.effect("should require a root directory when building a new volume", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(
        TreeTransfer.toVolume(Stream.make({ kind: "file", path: "/", bytes: new Uint8Array() } as const))
      )

      assert.deepStrictEqual(failure(error), ["InvalidEntry", "root"])
    }))

  it.effect("should report a root entry whose path is not well-formed as a missing root", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(
        TreeTransfer.toVolume(Stream.make({ kind: "directory", path: "\uD800" } as const))
      )

      assert.deepStrictEqual(failure(error), ["InvalidEntry", "root"])
    }))

  it.effect("should leave an existing destination file untouched when a file root is rejected", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.fromFixture({
        entries: [
          { kind: "file", path: "/source", bytes: text.encode("new") },
          { kind: "file", path: "/existing", bytes: text.encode("old") }
        ]
      })

      const caller = yield* volume.caller()

      const error = yield* Effect.flip(
        Stream.run(TreeTransfer.fromCaller(caller, "/source"), TreeTransfer.toCaller(caller, "/existing"))
      )

      assert.strictEqual(Schema.is(Vfs.VfsError)(error) && error.code, "AlreadyExists")
      assert.strictEqual(new TextDecoder().decode(yield* caller.readFile("/existing")), "old")
    }))

  for (
    const [name, entry] of [
      ["a parent reference", { kind: "directory", path: "/.." }],
      ["a current-directory reference", { kind: "file", path: "/.", bytes: new Uint8Array() }],
      ["an empty component", { kind: "directory", path: "/a/" }]
    ] satisfies ReadonlyArray<readonly [string, TreeTransfer.Entry]>
  ) {
    it.effect(`should reject ${name} when overwriting`, () =>
      Effect.gen(function*() {
        const destination = yield* (yield* Vfs.make()).caller()
        yield* destination.mkdir("/copy")

        const error = yield* Effect.flip(
          Stream.run(
            Stream.make<ReadonlyArray<TreeTransfer.Entry>>({ kind: "directory", path: "/" }, entry),
            TreeTransfer.toCaller(destination, "/copy", { existing: "overwrite" })
          )
        )

        assert.deepStrictEqual(failure(error), ["InvalidEntry", "path"])
        assert.deepStrictEqual(entryNames(yield* destination.readDirectory("/")), ["copy"])
      }))
  }

  it.effect("should reject an empty stream instead of reporting an empty copy", () =>
    Effect.gen(function*() {
      const destination = yield* (yield* Vfs.make()).caller()

      const error = yield* Effect.flip(Stream.run(Stream.empty, TreeTransfer.toCaller(destination, "/copy")))

      assert.deepStrictEqual(failure(error), ["InvalidEntry", "root"])
    }))

  for (
    const [name, entries, field] of [
      ["a child precedes its parent", [{ kind: "directory", path: "/a/b" }], "parent"],
      ["a path repeats", [{ kind: "directory", path: "/a" }, { kind: "directory", path: "/a" }], "path"],
      ["a hard link precedes its target", [{ kind: "hardLink", path: "/a", target: "/b" }], "target"]
    ] satisfies ReadonlyArray<readonly [string, ReadonlyArray<TreeTransfer.Entry>, string]>
  ) {
    it.effect(`should reject a new volume when ${name}`, () =>
      Effect.gen(function*() {
        const error = yield* Effect.flip(
          TreeTransfer.toVolume(Stream.fromIterable<TreeTransfer.Entry>([{ kind: "directory", path: "/" }, ...entries]))
        )

        assert.deepStrictEqual(failure(error), ["InvalidEntry", field])
      }))
  }

  it.effect("should drop owners and special bits when building a new volume by default", () =>
    Effect.gen(function*() {
      const volume = yield* TreeTransfer.toVolume(Stream.fromIterable<TreeTransfer.Entry>([
        { kind: "directory", path: "/", metadata: { uid: 501, gid: 20 } },
        { kind: "file", path: "/tool", bytes: new Uint8Array(), metadata: { uid: 501, gid: 20, mode: 0o4755 } }
      ]))

      const tool = yield* (yield* volume.caller()).stat(Vfs.Target.Path({ path: "/tool", followFinalSymlink: false }))

      assert.deepStrictEqual({ uid: tool.uid, gid: tool.gid, mode: tool.mode }, { uid: 0, gid: 0, mode: 0o755 })
    }))

  it.effect("should pass exactly at each limit and fail one below it", () =>
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

  it.effect("should count symbolic-link targets toward the byte limit", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.fromFixture({ entries: [{ kind: "symlink", path: "/link", target: "0123456789" }] })
      const limits = { ...TreeTransfer.TreeTransferLimits.default, maxBytes: ByteSize.bytes(9) }

      const error = yield* Effect.flip(
        Stream.runDrain(TreeTransfer.fromCaller(yield* volume.caller(), "/link", { limits }))
      )

      assert.deepStrictEqual(failure(error), ["LimitExceeded", "maxBytes"])
    }))

  it.effect("should fail a directory listing larger than the entry budget before visiting it", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.fromFixture({
        entries: ["a", "b", "c", "d"].map((name) => ({ kind: "file", path: `/${name}`, bytes: new Uint8Array() }))
      })

      const limits = { ...TreeTransfer.TreeTransferLimits.default, maxEntries: 3 }
      const entries: Array<TreeTransfer.Entry> = []

      const error = yield* Effect.flip(
        Stream.runForEach(
          TreeTransfer.fromCaller(yield* volume.caller(), "/", { limits }),
          (entry) => Effect.sync(() => entries.push(entry))
        )
      )

      assert.deepStrictEqual(failure(error), ["LimitExceeded", "maxEntries"])
      assert.deepStrictEqual(entries, [])
    }))

  it.effect("should not remove a destination that was replaced during a failed transfer", () =>
    Effect.gen(function*() {
      const destination = yield* (yield* Vfs.make()).caller()

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
    }))

  it.effect("should restore final directory modes when an overwriting transfer fails", () =>
    Effect.gen(function*() {
      const destination = yield* (yield* Vfs.make()).caller()

      const failing = Stream.fromIterable<TreeTransfer.Entry>([
        { kind: "directory", path: "/" },
        { kind: "directory", path: "/locked", metadata: { mode: 0o555 } }
      ]).pipe(Stream.concat(Stream.fail("source failed")))

      yield* Effect.exit(Stream.run(failing, TreeTransfer.toCaller(destination, "/copy", { existing: "overwrite" })))

      assert.strictEqual(
        (yield* destination.stat(Vfs.Target.Path({ path: "/copy/locked", followFinalSymlink: false }))).mode,
        0o555
      )
    }))
})

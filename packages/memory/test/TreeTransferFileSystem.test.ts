import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import { assert, it } from "@effect/vitest"
import { ByteSize, Effect, FileSystem, Result, Stream } from "effect"
import * as TreeTransfer from "../src/TreeTransfer.js"

const text = new TextEncoder()

// Whole milliseconds, so the host's millisecond timestamps can carry them exactly.
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

const snapshotEntries = (volume: Vfs.Volume, root: string) =>
  Effect.flatMap(volume.snapshot, (snapshot) => Stream.runCollect(TreeTransfer.fromSnapshot(snapshot, root)))

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

const failure = <E>(error: E) => error instanceof TreeTransfer.TransferError ? [error.code, error.path] : error

const withTemp = <A, E, R>(use: (fs: FileSystem.FileSystem, directory: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem

    return yield* use(fs, yield* fs.makeTempDirectoryScoped({ prefix: "tree-transfer-" }))
  }))

it.layer(NodeFileSystem.layer)("TreeTransfer host FileSystem", (it) => {
  it.effect("should round-trip a representative tree through the host within the declared losses", () =>
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

        assert.deepStrictEqual(failure(error), ["EscapingSymlink", "/passwd"])
        assert.isFalse(yield* fs.exists(`${directory}/export`))
      })
    ))

  it.effect("should resolve escape checks through links inside the tree", () =>
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
        assert.deepStrictEqual(failure(error), ["EscapingSymlink", "/out"])
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

  it.effect("should fail or report a non-UTF-8 name the host cannot carry", () =>
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

        assert.deepStrictEqual(failure(error), ["UnrepresentableName", raw])
        assert.deepStrictEqual(report.skipped, [{ path: raw, reason: "UnrepresentableName" }])
        assert.deepStrictEqual(yield* fs.readDirectory(`${directory}/lenient`), ["plain"])
      })
    ))

  it.effect("should report a name collision inside a claimed destination", () =>
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

  it.effect("should refuse to merge through a destination directory link", () =>
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

        assert.deepStrictEqual(failure(error), ["DestinationConflict", "/child"])
        assert.deepStrictEqual(yield* fs.readDirectory(`${directory}/outside`), [])
      })
    ))

  it.effect("should fail or skip an entry the host reports as a FIFO", () =>
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

        assert.deepStrictEqual(failure(error), ["UnsupportedEntryType", "/pipe"])
        assert.deepStrictEqual(entries.map((entry) => entry.path), ["/", "/file"])
        assert.deepStrictEqual(skipped, [{ path: "/pipe", reason: "UnsupportedEntryType" }])
      })
    ))

  it.effect("should fail an oversized host file before reading it whole", () =>
    withTemp((fs, directory) =>
      Effect.gen(function*() {
        yield* fs.writeFile(`${directory}/large`, new Uint8Array(1024))
        const limits = { ...TreeTransfer.TreeTransferLimits.default, maxFileBytes: ByteSize.bytes(16) }

        const error = yield* Effect.flip(
          Stream.runDrain(TreeTransfer.fromFileSystem(fs, `${directory}/large`, { limits }))
        )

        assert.deepStrictEqual(failure(error), ["LimitExceeded", "/"])
      })
    ))

  it.effect("should reject a link that escapes through a folded name", () =>
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

        assert.deepStrictEqual(failure(error), ["EscapingSymlink", "/m"])
        assert.isFalse(yield* fs.exists(`${directory}/export`))
      })
    ))

  it.effect("should reject a link that escapes through a link already in the destination", () =>
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

        assert.deepStrictEqual(failure(error), ["EscapingSymlink", "/m"])
        assert.isFalse(yield* fs.exists(`${directory}/export/m`))
      })
    ))

  it.effect("should not write through a link swapped in after an overwritten entry is removed", () =>
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

  it.effect("should report a hard link that collides instead of overwriting the existing name", () =>
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

  it.effect("should fail a colliding hard link instead of copying over the existing name", () =>
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

        assert.deepStrictEqual(failure(error), ["NameCollision", "/b"])
      })
    ))

  it.effect("should rewrite a hard link to a symbolic link as a link that resolves to the same place", () =>
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

  it.effect("should apply exact modes regardless of the host umask", () =>
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

  it.effect("should truncate sub-millisecond times through the host", () =>
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

  it.effect("should skip a colliding directory and everything below it", () =>
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

  it.effect("should fail or skip a host name that was not valid UTF-8", () =>
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

        assert.deepStrictEqual(failure(error), ["UnrepresentableName", "/bad\uFFFD"])
        assert.deepStrictEqual(entries.map((entry) => entry.path), ["/", "/file"])
      })
    ))

  it.effect("should emit a link that loops as a symbolic link", () =>
    withTemp((fs, directory) =>
      Effect.gen(function*() {
        yield* fs.makeDirectory(`${directory}/tree`)
        yield* fs.symlink("self", `${directory}/tree/self`)

        const entries = yield* Stream.runCollect(TreeTransfer.fromFileSystem(fs, `${directory}/tree`))

        assert.deepStrictEqual(entries[1], { kind: "symlink", path: "/self", target: "self" })
      })
    ))

  it.effect("should reject an empty stream written to the host", () =>
    withTemp((fs, directory) =>
      Effect.gen(function*() {
        const error = yield* Effect.flip(Stream.run(Stream.empty, TreeTransfer.toFileSystem(fs, `${directory}/export`)))

        assert.deepStrictEqual(failure(error), ["InvalidEntry", undefined])
      })
    ))
})

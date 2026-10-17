import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import { assert, it } from "@effect/vitest"
import { Effect, FileSystem, Option, Stream } from "effect"
import * as MemoryFileSystem from "../src/MemoryFileSystem.js"
import * as TreeTransfer from "../src/TreeTransfer.js"
import { snapshotEntries } from "./support/snapshotEntries.js"
import { FOUR_FILES_FIXTURE, representativeTree } from "./support/treeTransferFixtures.js"

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

import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect, FileSystem, type PlatformError, Stream } from "effect"
import { MemoryFileSystem, TreeTransfer } from "../src/index.js"

const fixture: Vfs.Fixture = { entries: [{ kind: "file", path: "/file", bytes: Uint8Array.of(7) }] }

const volumeOptions: Vfs.VolumeOptions = { maxBytes: ByteSize.kibibytes(4) }

const callerOptions: Vfs.RootCallerOptions = { umask: 0o077 }

const entries = Stream.fromIterable<TreeTransfer.Entry>([
  { kind: "directory", path: "/" },
  { kind: "file", path: "/file", bytes: Uint8Array.of(7) }
])

describe("dual adapter and transfer construction", () => {
  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should use the requested caller mask when binding with either call style", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.fromFixture(fixture)

        const binds = [
          MemoryFileSystem.bind(volume),
          MemoryFileSystem.bind(volume, undefined),
          MemoryFileSystem.bind(volume, callerOptions),
          MemoryFileSystem.bind()(volume),
          MemoryFileSystem.bind(undefined)(volume),
          MemoryFileSystem.bind(callerOptions)(volume)
        ]

        const caller = yield* volume.caller()

        for (const [index, bind] of binds.entries()) {
          const fs = yield* bind
          assert.deepStrictEqual(yield* fs.readFile("/file"), Uint8Array.of(7))
          yield* fs.writeFileString(`/new-${index}`, "hello")
          assert.strictEqual((yield* caller.stat(`/new-${index}`)).mode, index === 2 || index === 5 ? 0o600 : 0o644)
        }
      }))

    it.effect("should build isolated fixture layers when volume and caller options are partially applied", () =>
      Effect.gen(function*() {
        const layers = [
          MemoryFileSystem.layerFromFixture(fixture),
          MemoryFileSystem.layerFromFixture(fixture, undefined),
          MemoryFileSystem.layerFromFixture(fixture, volumeOptions),
          MemoryFileSystem.layerFromFixture(fixture, volumeOptions, callerOptions),
          MemoryFileSystem.layerFromFixture()(fixture),
          MemoryFileSystem.layerFromFixture(undefined)(fixture),
          MemoryFileSystem.layerFromFixture(volumeOptions)(fixture),
          MemoryFileSystem.layerFromFixture(volumeOptions, callerOptions)(fixture),
          MemoryFileSystem.layerFromFixture(undefined, callerOptions)(fixture)
        ]

        const read = Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          assert.deepStrictEqual(yield* fs.readFile("/file"), Uint8Array.of(7))
          assert.isFalse(yield* fs.exists("/new"))
          yield* fs.writeFileString("/new", "hello")
        })

        for (const layer of layers) {
          yield* read.pipe(Effect.provide(layer))
        }
      }))

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

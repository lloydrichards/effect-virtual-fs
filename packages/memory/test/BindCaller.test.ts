import { VfsError, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import * as MemoryFileSystem from "../src/MemoryFileSystem.js"

describe("borrowed caller filesystem", () => {
  it.layer(NodeCrypto.layer)((it) => {
    it.effect("preserves confinement, cwd, and umask without adding tmp", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.fromFixture({
          entries: [{ kind: "directory", path: "/tenant" }, { kind: "directory", path: "/tenant/work" }]
        })

        const owner = yield* volume.caller({ umask: 0o077 })
        const confined = yield* owner.withRoot("/tenant")
        const caller = yield* confined.withDirectory("/work")
        const fs = yield* MemoryFileSystem.bindCaller(caller)
        yield* fs.writeFileString("relative", "inside")
        assert.strictEqual(yield* fs.readFileString("/work/relative"), "inside")
        assert.strictEqual((yield* owner.stat("/tenant/work/relative")).mode & 0o777, 0o600)
        assert.strictEqual((yield* Effect.flip(fs.makeTempDirectory())).reason._tag, "NotFound")
        assert.isFalse(yield* fs.exists("/tmp"))
      }))

    it.effect("cleans the original temporary directory after rename without deleting its replacement", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.fromFixture({
          entries: [{ kind: "directory", path: "/tenant" }, { kind: "directory", path: "/tenant/tmp" }]
        })

        const owner = yield* volume.caller()
        const fs = yield* MemoryFileSystem.bindCaller(yield* owner.withRoot("/tenant"))
        let original = ""
        yield* Effect.scoped(Effect.gen(function*() {
          original = yield* fs.makeTempDirectoryScoped()
          yield* fs.rename(original, "/moved")
          yield* fs.makeDirectory(original)
          yield* fs.writeFileString(`${original}/replacement`, "keep")
        }))
        assert.isFalse(yield* fs.exists("/moved"))
        assert.strictEqual(yield* fs.readFileString(`${original}/replacement`), "keep")
      }))

    it.effect("retries cleanup when a rename and replacement race conditional removal", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.fromFixture({
          entries: [
            { kind: "directory", path: "/tenant" },
            { kind: "directory", path: "/tenant/tmp" }
          ]
        })

        const owner = yield* volume.caller()
        const caller = yield* owner.withRoot("/tenant")
        let temporary = ""
        let raced = false

        // SAFETY: Delegation preserves both remove overloads; force controls the underlying result exactly as before.
        const remove = ((entry: Vfs.EntryInput, options?: Vfs.RemoveOptions) =>
          Effect.gen(function*() {
            if (!raced) {
              raced = true
              yield* owner.rename(`/tenant${temporary}`, "/tenant/moved")
              yield* owner.mkdir(`/tenant${temporary}`)
            }

            return yield* caller.remove(entry, options ?? {})
          })) as Vfs.Caller["remove"]

        const fs = yield* MemoryFileSystem.bindCaller({ ...caller, remove })
        yield* Effect.scoped(Effect.gen(function*() {
          temporary = yield* fs.makeTempDirectoryScoped()
        }))
        assert.isFalse(yield* fs.exists("/moved"))
        assert.isTrue(yield* fs.exists(temporary))
      }))

    it.effect("leaves a temporary alone after a trusted move outside its root", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.fromFixture({
          entries: [{ kind: "directory", path: "/tenant" }, { kind: "directory", path: "/tenant/tmp" }]
        })

        const owner = yield* volume.caller()
        const fs = yield* MemoryFileSystem.bindCaller(yield* owner.withRoot("/tenant"))
        yield* Effect.scoped(Effect.gen(function*() {
          const path = yield* fs.makeTempDirectoryScoped()
          yield* owner.rename(`/tenant${path}`, "/outside")
        }))
        assert.strictEqual((yield* owner.stat("/outside")).kind, "directory")
      }))

    it.effect("keeps directory copy and glob inside the borrowed root", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.fromFixture({
          entries: [
            { kind: "directory", path: "/tenant" },
            { kind: "directory", path: "/tenant/source" },
            { kind: "file", path: "/tenant/source/file.ts", bytes: new TextEncoder().encode("inside") },
            { kind: "file", path: "/file.ts", bytes: new TextEncoder().encode("outside") }
          ]
        })

        const owner = yield* volume.caller()
        const fs = yield* MemoryFileSystem.bindCaller(yield* owner.withRoot("/tenant"))
        yield* fs.copy("/source", "/copy")
        assert.strictEqual(yield* fs.readFileString("/copy/file.ts"), "inside")
        assert.deepStrictEqual(yield* fs.glob("**/*.ts", { root: "/" }), ["copy/file.ts", "source/file.ts"])
        assert.strictEqual((yield* Effect.flip(fs.readFile("/../../file.ts"))).reason._tag, "NotFound")
        assert.strictEqual(new TextDecoder().decode(yield* owner.readFile("/file.ts")), "outside")
      }))

    it.effect("translates failures that occur while consuming a caller watch", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.make()
        const caller = yield* volume.caller()

        const fs = yield* MemoryFileSystem.bindCaller({
          ...caller,
          watch: () => Effect.succeed(Stream.fail(VfsError.make({ code: "ClosedCaller", operation: "watch" })))
        })

        const failure = yield* Effect.flip(Stream.runDrain(fs.watch("/")))
        assert.strictEqual(failure._tag, "PlatformError")
        assert.strictEqual(failure.reason._tag, "BadResource")
      }))
  })
})

import { assert, describe } from "@effect/vitest"
import { ByteSize, Effect } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"
import { openImageVolume, prepareEmptyLiveImage } from "../src/internal/virtualFileSystem.js"
import { it } from "./TestEffect.js"

const encoder = new TextEncoder()

// Which operation and which argument an error names, with an absent path kept distinct from undefined.
interface Attribution {
  readonly code: Vfs.FsCode
  readonly operation: string
  readonly path: unknown
}

const attribution = (error: Vfs.FsError): Attribution => ({
  code: error.code,
  operation: error.operation,
  path: "path" in error ? error.path : "<absent>"
})

describe("filesystem error attribution", () => {
  it.effect("names the argument that failed in two-path operations", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make()).caller()
      yield* fs.writeFile("/a", new Uint8Array([1]), { access: "write", create: "exclusive" })
      yield* fs.writeFile("/b", new Uint8Array([2]), { access: "write", create: "exclusive" })

      assert.deepEqual(attribution(yield* Effect.flip(fs.rename("/missing", "/c"))), {
        code: "NotFound",
        operation: "rename",
        path: "/missing"
      })

      assert.deepEqual(attribution(yield* Effect.flip(fs.rename("/a", "/nowhere/c"))), {
        code: "NotFound",
        operation: "rename",
        path: "/nowhere/c"
      })

      assert.deepEqual(attribution(yield* Effect.flip(fs.link("/a", "/b"))), {
        code: "AlreadyExists",
        operation: "link",
        path: "/b"
      })

      assert.deepEqual(attribution(yield* Effect.flip(fs.symlink("bad\0target", "/link"))), {
        code: "InvalidArgument",
        operation: "symlink",
        path: "bad\0target"
      })
    }))

  it.effect("reports read and write for positional validation but pread and pwrite for admission", () =>
    Effect.scoped(Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make()).caller()
      const handle = yield* fs.open("/file", { access: "readWrite", create: "exclusive" })

      assert.deepEqual(attribution(yield* Effect.flip(handle.pread(-1, 0n))), {
        code: "InvalidArgument",
        operation: "read",
        path: "<absent>"
      })

      assert.deepEqual(attribution(yield* Effect.flip(handle.pwrite(new Uint8Array([1]), -1n))), {
        code: "InvalidArgument",
        operation: "write",
        path: "<absent>"
      })

      yield* handle.close

      assert.deepEqual(attribution(yield* Effect.flip(handle.pread(1, 0n))), {
        code: "InvalidHandle",
        operation: "pread",
        path: "<absent>"
      })

      assert.deepEqual(attribution(yield* Effect.flip(handle.pwrite(new Uint8Array([1]), 0n))), {
        code: "InvalidHandle",
        operation: "pwrite",
        path: "<absent>"
      })
    })))

  it.effect("keeps reference failures pathless and names scoped directory entry points", () =>
    Effect.scoped(Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make()).caller()
      const root = yield* fs.rootReference

      assert.deepEqual(attribution(yield* Effect.flip(fs.unlinkReference(root, encoder.encode("missing")))), {
        code: "NotFound",
        operation: "unlinkReference",
        path: "<absent>"
      })

      assert.deepEqual(attribution(yield* Effect.flip(fs.withDirectory("/missing"))), {
        code: "NotFound",
        operation: "withDirectory",
        path: "/missing"
      })
    })))

  it.effect("keeps the path key an untyped caller left undefined", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make()).caller()
      // SAFETY: deliberately violates PathInput to pin the error shape an untyped caller sees.
      const error = yield* Effect.flip(fs.symlink(undefined as never, "/link"))

      assert.deepEqual(attribution(error), { code: "InvalidArgument", operation: "symlink", path: undefined })
    }))

  it.effect("attributes an oversized live image to the commit", () =>
    Effect.gen(function*() {
      const stored = yield* prepareEmptyLiveImage()

      const session = yield* openImageVolume(
        stored,
        ByteSize.bytes(stored.length + 64),
        () => Effect.succeed("committed" as const)
      )

      const fs = yield* session.volume.caller()
      const bytes = new Uint8Array(1024)

      assert.deepEqual(
        attribution(yield* Effect.flip(fs.writeFile("/large", bytes, { access: "write", create: "exclusive" }))),
        { code: "StorageRejected", operation: "commit", path: "<absent>" }
      )

      yield* session.shutdown
    }))
})

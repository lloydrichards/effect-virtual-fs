import { LiveVolume } from "@effect-vfs/core"
import * as R2LiveImageStore from "@effect-vfs/persistence/R2LiveImageStore"
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto"
import { assert, describe, it } from "@effect/vitest"
import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import { keyFor, NotebookR2, type NotebookR2Client, NotebookService } from "../src/notebook.js"

const remote = () => {
  let record: { bytes: Uint8Array; etag: string; generation: string; digest: string } | null = null
  let version = 0
  let deleteAfterRead = false
  let failRemove = false
  let writes = 0
  let failAt = Infinity

  const client: NotebookR2Client = {
    read: () =>
      Effect.sync(() => {
        const snapshot = record === null ? null : { ...record, bytes: new Uint8Array(record.bytes) }

        if (deleteAfterRead) record = null

        return snapshot
      }),
    write: (_key, bytes, generation, digest, condition) =>
      Effect.suspend(() => {
        if ("ifNoneMatch" in condition ? record !== null : record?.etag !== condition.ifMatch) {
          return Effect.succeed(null)
        }

        writes++

        if (writes === failAt) return Effect.fail(new LiveVolume.LiveVolumeError({ code: "Storage" }))

        const etag = `"${++version}"`
        record = { bytes: new Uint8Array(bytes), etag, generation, digest }

        return Effect.succeed({ etag })
      }),
    remove: () =>
      Effect.suspend(() => {
        if (failRemove) return Effect.fail(new LiveVolume.LiveVolumeError({ code: "Storage" }))
        record = null

        return Effect.void
      })
  }

  return {
    client,
    deleteAfterNextRead: () => {
      deleteAfterRead = true
    },
    exists: () => record !== null,
    writes: () => writes,
    failOnWrite: (number: number) => {
      failAt = number
    },
    failOnRemove: () => {
      failRemove = true
    }
  }
}

const testLayer = (r2: ReturnType<typeof remote>) =>
  NotebookService.Live.pipe(Layer.provide(Layer.merge(BrowserCrypto.layer, Layer.succeed(NotebookR2, r2.client))))

const openPersistedVolume = (r2: ReturnType<typeof remote>, id: string) => {
  const store = R2LiveImageStore.layer({
    client: r2.client,
    key: keyFor(id),
    maxImageBytes: ByteSize.kilobytes(64),
    durability: "survives-power-loss"
  }).pipe(Layer.provide(BrowserCrypto.layer))

  return LiveVolume.open({
    maxImageBytes: ByteSize.kilobytes(64),
    volume: {
      maxEntries: 100,
      maxBytes: ByteSize.kilobytes(32),
      maxFileBytes: ByteSize.kilobytes(16),
      maxPathBytes: ByteSize.bytes(1024)
    }
  }).pipe(Effect.provide(Layer.merge(store, BrowserCrypto.layer)))
}

describe("R2 notebook", () => {
  it.effect("creates a published file and reopens it from a fresh volume", () => {
    const r2 = remote()

    return Effect.gen(function*() {
      const notebooks = yield* NotebookService
      const created = yield* notebooks.create

      const createdNotebook = Result.match(created, {
        onSuccess: (notebook) => notebook,
        onFailure: () => assert.fail("creation failed")
      })

      const reopened = yield* notebooks.read(createdNotebook.id)

      assert.deepStrictEqual(reopened, createdNotebook)
      assert.deepStrictEqual(reopened?.files, ["/published/hello.txt"])
      assert.isTrue(r2.exists())
      assert.isAbove(r2.writes(), 1)
    }).pipe(Effect.provide(testLayer(r2)))
  })

  it.effect("allows readers to read published files but not modify them", () => {
    const r2 = remote()

    return Effect.gen(function*() {
      const notebooks = yield* NotebookService
      const created = yield* notebooks.create

      const id = Result.match(created, {
        onSuccess: (notebook) => notebook.id,
        onFailure: () => assert.fail("creation failed")
      })

      const denied = yield* Effect.scoped(Effect.gen(function*() {
        const volume = yield* openPersistedVolume(r2, id)

        const reader = yield* volume.caller({
          identity: { uid: 2000, gid: 2000, groups: [], privileged: false },
          umask: 0o022
        })

        assert.strictEqual(
          new TextDecoder().decode(yield* reader.readFile("/published/hello.txt")),
          "A virtual file, committed as one R2 image."
        )

        return yield* Effect.flip(reader.writeFile("/published/hello.txt", new TextEncoder().encode("changed"), {
          access: "write",
          truncate: true
        }))
      }))

      assert.strictEqual(denied.code, "AccessDenied")
    }).pipe(Effect.provide(testLayer(r2)))
  })

  it.effect("cleans a partial image when creation fails", () => {
    const r2 = remote()
    r2.failOnWrite(3)

    return Effect.gen(function*() {
      const notebooks = yield* NotebookService
      const result = yield* notebooks.create

      Result.match(result, {
        onFailure: ({ id, cleanup }) => {
          assert.match(id, /^[0-9a-f-]{36}$/)
          assert.strictEqual(cleanup, "removed")
        },
        onSuccess: () => assert.fail("creation should fail")
      })
      assert.isFalse(r2.exists())
    }).pipe(Effect.provide(testLayer(r2)))
  })

  it.effect("reports an image ID if failed creation cannot be cleaned", () => {
    const r2 = remote()
    r2.failOnWrite(3)
    r2.failOnRemove()

    return Effect.gen(function*() {
      const notebooks = yield* NotebookService
      const result = yield* notebooks.create

      Result.match(result, {
        onFailure: ({ id, cleanup }) => {
          assert.match(id, /^[0-9a-f-]{36}$/)
          assert.strictEqual(cleanup, "retry-delete")
        },
        onSuccess: () => assert.fail("creation should fail")
      })
      assert.isTrue(r2.exists())
    }).pipe(Effect.provide(testLayer(r2)))
  })

  it.effect("does not recreate an image deleted after the read begins", () => {
    const r2 = remote()

    return Effect.gen(function*() {
      const notebooks = yield* NotebookService
      const created = yield* notebooks.create

      const id = Result.match(created, {
        onSuccess: (notebook) => notebook.id,
        onFailure: () => assert.fail("creation failed")
      })

      const writes = r2.writes()
      r2.deleteAfterNextRead()

      const reopened = yield* notebooks.read(id)

      assert.strictEqual(reopened, null)
      assert.isFalse(r2.exists())
      assert.strictEqual(r2.writes(), writes)
      assert.strictEqual(yield* notebooks.read(id), null)
    }).pipe(Effect.provide(testLayer(r2)))
  })

  it.effect("removes the notebook image", () => {
    const r2 = remote()

    return Effect.gen(function*() {
      const notebooks = yield* NotebookService
      const created = yield* notebooks.create

      const id = Result.match(created, {
        onSuccess: (notebook) => notebook.id,
        onFailure: () => assert.fail("creation failed")
      })

      yield* notebooks.remove(id)

      assert.isFalse(r2.exists())
      assert.strictEqual(yield* notebooks.read(id), null)
    }).pipe(Effect.provide(testLayer(r2)))
  })
})

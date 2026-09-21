import { LiveVolume } from "@effect-vfs/core"
import type { R2Client } from "@effect-vfs/persistence/R2LiveImageStore"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { createNotebook, createWithCleanup, readNotebook } from "../src/notebook.js"

const remote = () => {
  let record: { bytes: Uint8Array; etag: string; generation: string; digest: string } | null = null
  let version = 0
  let deleteAfterRead = false
  let writes = 0
  let failAt = Infinity

  const client: R2Client = {
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
    remove: Effect.sync(() => {
      record = null
    })
  }
}

describe("R2 notebook", () => {
  it.effect("creates a published file and reopens it from a fresh volume", () =>
    Effect.gen(function*() {
      const r2 = remote()
      const id = "9d12e3b4-d491-4b08-a69a-bd20ba4ac7c2"
      const created = yield* createNotebook(r2.client, id)
      const reopened = yield* readNotebook(r2.client, id)

      assert.deepStrictEqual(created.files, ["/published/hello.txt"])
      assert.deepStrictEqual(reopened, created)
      assert.isTrue(r2.exists())
      assert.isAbove(r2.writes(), 1)
    }))

  it.effect("cleans a partial image when creation fails", () =>
    Effect.gen(function*() {
      const r2 = remote()
      r2.failOnWrite(3)

      const result = yield* createWithCleanup(r2.client, "a47b198c-4e28-447b-a975-c7beb085c61e", r2.remove)

      assert.deepStrictEqual(result, {
        _tag: "Failed",
        id: "a47b198c-4e28-447b-a975-c7beb085c61e",
        cleanup: "removed"
      })
      assert.isFalse(r2.exists())
    }))

  it.effect("reports an image ID if failed creation cannot be cleaned", () =>
    Effect.gen(function*() {
      const r2 = remote()
      r2.failOnWrite(3)
      const id = "60d926ac-bf70-4528-b41a-976b95c5cd91"

      const result = yield* createWithCleanup(
        r2.client,
        id,
        Effect.fail(new LiveVolume.LiveVolumeError({ code: "Storage" }))
      )

      assert.deepStrictEqual(result, { _tag: "Failed", id, cleanup: "retry-delete" })
      assert.isTrue(r2.exists())
    }))

  it.effect("does not recreate an image deleted after the read begins", () =>
    Effect.gen(function*() {
      const r2 = remote()
      const id = "b43d456f-b9dd-4f1f-9a28-39625a8c77b5"
      yield* createNotebook(r2.client, id)
      const writes = r2.writes()
      r2.deleteAfterNextRead()

      const reopened = yield* readNotebook(r2.client, id)

      assert.strictEqual(reopened, null)
      assert.isFalse(r2.exists())
      assert.strictEqual(r2.writes(), writes)
      assert.strictEqual(yield* readNotebook(r2.client, id), null)
    }))
})

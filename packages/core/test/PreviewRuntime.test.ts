/* eslint-disable effecttsgo/experimental-api-usage */
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"
import { runtimeOf } from "../src/internal/runtime.js"
import * as SynchronousAdapter from "../src/SynchronousAdapter.js"

const bytes = Uint8Array.of(1, 2, 3)

const create = { access: "write", create: "exclusive" } as const

describe("preview ownership", () => {
  it.layer(BunCrypto.layer)((it) => {
    for (const execution of ["cooperative", "sync"] as const) {
      it.effect(`shares ${execution} core writes with the public preview owner`, () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.make({ execution })
          const runtime = runtimeOf(volume)
          assert.isDefined(runtime)

          if (runtime === undefined) return assert.fail("Core did not construct preview state")
          const core = yield* volume.caller()
          const preview = yield* runtime.owner.authorize({ credentials: { uid: 0, gid: 0, privileged: true } })
          yield* core.writeFile("/core", bytes, create)
          assert.deepStrictEqual(yield* preview.readFile("/core"), bytes)
          yield* preview.writeFile("/preview", bytes)
          assert.deepStrictEqual(yield* core.readFile("/preview"), bytes)
          const restored = yield* Vfs.fromSnapshot(yield* volume.snapshot)
          assert.isDefined(runtimeOf(restored))
          assert.deepStrictEqual(yield* (yield* restored.caller()).readFile("/core"), bytes)
        }))
    }

    it.effect("shares native writes with the same public preview owner", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.make({ execution: "sync" })
        const runtime = runtimeOf(volume)
        assert.isDefined(runtime)

        if (runtime === undefined) return assert.fail("Core did not construct preview state")
        const native = yield* SynchronousAdapter.bind(volume)
        const handle = native.open("/native", create, false, false)
        assert.strictEqual(handle.write(bytes, 0n, false), bytes.length)
        handle.close()
        const preview = yield* runtime.owner.authorize({ credentials: { uid: 0, gid: 0, privileged: true } })
        assert.deepStrictEqual(yield* preview.readFile("/native"), bytes)
      }))
  })
})

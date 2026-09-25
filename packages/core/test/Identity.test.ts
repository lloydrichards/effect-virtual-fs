import { assert, describe, it } from "@effect/vitest"
import { Effect, Random } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"

// These tests provide no Crypto service, so identity comes from Effect's Random.
const HEX_128 = /^[0-9a-f]{32}$/

describe("volume identity without Crypto", () => {
  it.effect("mints distinct 128-bit identities and incarnations", () =>
    Effect.gen(function*() {
      const first = yield* Vfs.make()
      const second = yield* Vfs.make()

      assert.match(first.identity, HEX_128)
      assert.match(first.incarnation, HEX_128)
      assert.notStrictEqual(first.identity, second.identity)
      assert.notStrictEqual(first.incarnation, second.incarnation)
    }))

  it.effect("follows a seeded Random, so a test can pin its identities", () =>
    Effect.gen(function*() {
      const seeded = () => Effect.map(Vfs.make(), (volume) => volume.identity).pipe(Random.withSeed("identity"))

      assert.strictEqual(yield* seeded(), yield* seeded())
    }))
})

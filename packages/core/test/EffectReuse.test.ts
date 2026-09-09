import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Scope, Stream } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"

describe("reusable capability effects", () => {
  it.effect("reads current metadata and rejects operations after explicit close", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const directory = yield* caller.openDirectory("/")
      const file = yield* caller.open("/f", { access: "readWrite", create: "exclusive" })
      const stat = file.stat
      const sync = file.sync
      const close = file.close
      const directoryStat = directory.stat
      const directoryClose = directory.close
      const before = yield* stat
      const directoryBefore = yield* directoryStat
      yield* sync
      yield* file.write(new Uint8Array([1, 2]))
      yield* caller.mkdir("/child")
      assert.strictEqual((yield* stat).size, 2n)
      assert.strictEqual(before.size, 0n)
      assert.strictEqual((yield* directoryStat).nlink, directoryBefore.nlink + 1)
      yield* sync
      yield* close
      assert.strictEqual((yield* Effect.flip(stat)).code, "InvalidHandle")
      assert.strictEqual((yield* Effect.flip(sync)).code, "InvalidHandle")
      assert.strictEqual((yield* Effect.flip(close)).code, "InvalidHandle")
      yield* directoryClose
      assert.strictEqual((yield* Effect.flip(directoryStat)).code, "InvalidHandle")
      assert.strictEqual((yield* Effect.flip(directoryClose)).code, "InvalidHandle")
    }))

  it.effect("captures fresh isolated state each time the same snapshot effect runs", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const caller = yield* volume.caller()
      const capture = volume.snapshot
      const before = yield* capture
      yield* caller.mkdir("/later")
      const after = yield* capture
      const original = yield* (yield* Vfs.fromSnapshot(before)).caller()
      const updated = yield* (yield* Vfs.fromSnapshot(after)).caller()
      assert.deepStrictEqual(yield* original.readDirectory("/"), [])
      assert.deepStrictEqual(yield* updated.readDirectory("/"), ["later"])
    }))

  it.effect("subscribes independently on each execution and closes only the owning subscription", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const caller = yield* volume.caller()
      const watch = volume.watch
      const firstScope = yield* Scope.make()
      const secondScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void))
      yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void))
      const first = yield* watch.pipe(Scope.provide(firstScope))
      const second = yield* watch.pipe(Scope.provide(secondScope))
      yield* caller.mkdir("/both")
      const firstEvents = yield* first.pipe(Stream.take(1), Stream.runCollect)
      const secondEvents = yield* second.pipe(Stream.take(1), Stream.runCollect)
      assert.strictEqual(firstEvents.length, 1)
      assert.deepStrictEqual(secondEvents, firstEvents)
      yield* Scope.close(firstScope, Exit.void)
      yield* caller.mkdir("/second")
      const remaining = yield* second.pipe(Stream.take(1), Stream.runCollect)
      assert.strictEqual(remaining.length, 1)
      const event = remaining[0]
      assert.isDefined(event)
      assert.deepStrictEqual(yield* Vfs.pathToBytes(event.path), new TextEncoder().encode("/second"))
    }))
})

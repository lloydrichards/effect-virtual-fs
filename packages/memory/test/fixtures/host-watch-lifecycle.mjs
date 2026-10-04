import assert from "node:assert/strict"
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Native close events are the resource under test.
import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import { Deferred, Effect, Fiber, FileSystem, Stream } from "effect"

// An isolated process observes the real native close event without altering other tests.
const originalWatch = fs.watch

let opened = 0

let closed = 0

const closedEvent = Deferred.makeUnsafe()

fs.watch = (...args) => {
  const watcher = originalWatch(...args)
  opened++
  watcher.once("close", () => {
    closed++
    Deferred.doneUnsafe(closedEvent, Effect.void)
  })

  return watcher
}

syncBuiltinESMExports()

try {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const service = yield* FileSystem.FileSystem
    const directory = yield* service.makeTempDirectoryScoped({ prefix: "effect-host-watch-release-" })
    const observed = yield* Deferred.make()

    const watcher = yield* service.watch(directory).pipe(
      Stream.filter((event) => event.path.endsWith("ready.txt")),
      Stream.runForEach(() => Deferred.succeed(observed, undefined)),
      Effect.forkChild
    )

    for (let attempt = 0; attempt < 100 && !(yield* Deferred.isDone(observed)); attempt++) {
      yield* service.writeFileString(`${directory}/ready.txt`, "ready")
      yield* Effect.sleep("10 millis")
    }

    assert.equal(yield* Deferred.isDone(observed), true, "Native watcher must deliver before interruption")
    assert.equal(opened, 1)
    yield* Fiber.interrupt(watcher)
    yield* Deferred.await(closedEvent).pipe(Effect.timeout("3 seconds"))
    assert.equal(closed, 1)
  })).pipe(Effect.provide(NodeFileSystem.layer)))

  process.stdout.write("Native watcher closed after interruption.\n")
} finally {
  fs.watch = originalWatch
  syncBuiltinESMExports()
}

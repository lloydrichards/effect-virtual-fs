import * as Vfs from "@effect-vfs/core/VirtualFileSystem"
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto"
import { Effect, Stream } from "effect"
import { SharedMemory } from "effect/workers"
import { expect, test } from "vitest"
import { RenderEvent, WorkshopError, workshopError } from "../app/examples/image-tile-workshop/domain.ts"
import { makeRenderSession } from "../app/examples/image-tile-workshop/render-session.ts"

test("a committed tile keeps its version when the compositor fails to apply it", () =>
  Effect.runPromise(
    Effect.scoped(Effect.gen(function*() {
      const makeVolume = Vfs.make().pipe(
        Effect.provide([BrowserCrypto.layerDigest, BrowserCrypto.layerSecureRandom]),
        Effect.mapError(workshopError)
      )

      let failCompose = false

      const session = yield* makeRenderSession(makeVolume, {
        reset: () => Effect.void,
        apply: (_tile, path, _bounds, read) =>
          read(path).pipe(Effect.filterOrFail(
            () => !failCompose,
            () => new WorkshopError({ message: "Composition failed." })
          )),
        swap: () => Effect.void,
        encode: Effect.succeed(Uint8Array.of(42))
      }, (id) => Effect.succeed(() => Effect.succeed(Uint8Array.of(id))))

      yield* session.render({
        source: { width: 6, height: 4, pixels: SharedMemory.make(Uint8ClampedArray, 6 * 4 * 4) },
        filter: "normal",
        setup: { workers: 2, grid: "2x2" }
      }).pipe(Stream.runDrain)

      failCompose = true
      const failed = yield* session.rebuild({ tiles: [0], filter: "invert" }).pipe(Stream.runCollect)
      expect(failed.find(RenderEvent.guards.committed)).toMatchObject({ tile: 0, worker: 2, version: 2 })
      expect(failed.find(RenderEvent.guards.failed)).toMatchObject({ tile: 0, version: 2, stage: "compose" })
      expect(failed.some(RenderEvent.guards.applied)).toBe(false)

      failCompose = false
      const retried = yield* session.rebuild({ tiles: [0], filter: "invert" }).pipe(Stream.runCollect)
      expect(retried.find(RenderEvent.guards.assigned)).toMatchObject({ worker: 2, previousWorker: 1, version: 3 })
      expect(retried.find(RenderEvent.guards.applied)).toMatchObject({ tile: 0, version: 3, png: Uint8Array.of(2) })
    }))
  ))

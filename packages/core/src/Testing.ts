/**
 * Test helpers over the `Volume` and `Caller` services: a fresh volume with a
 * root caller as one layer, callers with other credentials on the volume in
 * context, and collecting a known number of watch changes.
 *
 * **Details**
 *
 * The helpers are plain Effect values with no test-runner dependency. Each
 * build of `layer` is a fresh volume, so provide it to every test that needs
 * its own state, and share one build only between tests that do not
 * interfere.
 *
 * @since 0.6.0
 */
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type { Identity, RootCallerOptions } from "./Caller.js"
import type { Fixture } from "./Fixture.js"
import type { VfsError } from "./VfsError.js"
import { Caller, Volume } from "./VirtualFileSystem.js"
import type { VolumeOptions } from "./Volume.js"

/**
 * Options of a test volume layer.
 *
 * @category models
 * @since 0.6.0
 */
export interface LayerOptions {
  /** Entries the volume starts with; without one the volume starts empty. */
  readonly fixture?: Fixture
  /** Limits and identity of the volume. */
  readonly volume?: VolumeOptions
  /** Credentials and umask of the root caller the layer provides. */
  readonly caller?: RootCallerOptions
}

/**
 * A fresh volume and a root caller on it, as one layer.
 *
 * **Details**
 *
 * Every build constructs a new volume, from `fixture` when one is given. The
 * layer fails with the `VfsError` the constructor or the caller reports for
 * invalid options.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as Testing from "@effect-vfs/core/Testing"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const fs = yield* Vfs.Caller
 *   yield* fs.mkdir("/work")
 *
 *   return (yield* fs.readDirectory("/")).value.map((entry) => new TextDecoder().decode(entry.name))
 * })
 *
 * // Each provide builds its own volume, so neither run sees the other's writes.
 * Effect.runPromise(program.pipe(Effect.provide(Testing.layer()))).then(console.log)
 * // [ 'work' ]
 * ```
 *
 * @category layers
 * @since 0.6.0
 */
export const layer = (options?: LayerOptions): Layer.Layer<Volume | Caller, VfsError> =>
  Caller.layer(options?.caller).pipe(
    Layer.provideMerge(
      options?.fixture === undefined
        ? Volume.layer(options?.volume)
        : Volume.layerFromFixture(options.fixture, options.volume)
    )
  )

/**
 * A root caller with `identity` on the volume in context.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as Testing from "@effect-vfs/core/Testing"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* (yield* Vfs.Caller).mkdir("/private", { mode: 0o700 })
 *
 *   const guest = yield* Testing.callerAs({ uid: 1000, gid: 1000, groups: [], privileged: false })
 *
 *   return (yield* Effect.flip(guest.readDirectory("/private"))).code
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(Testing.layer()))).then(console.log)
 * // AccessDenied
 * ```
 *
 * @category constructors
 * @since 0.6.0
 */
export const callerAs = (
  identity: Identity,
  options?: Omit<RootCallerOptions, "identity">
): Effect.Effect<Caller, VfsError, Volume> =>
  Effect.flatMap(Volume, (volume) => volume.caller({ ...options, identity }))

/**
 * Starts collecting the first `n` elements of `stream` and returns an effect
 * that waits for them.
 *
 * **Details**
 *
 * The collection runs in a fiber of the current scope, so the returned effect
 * can be awaited after the writes that produce the changes. Open the watch
 * stream before writing: a volume publishes only changes committed after the
 * subscription.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as Testing from "@effect-vfs/core/Testing"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const volume = yield* Vfs.Volume
 *   const changes = yield* Testing.collectChanges(yield* volume.watch(), 1)
 *
 *   yield* (yield* Vfs.Caller).mkdir("/work")
 *
 *   return (yield* changes).map((change) => change._tag)
 * })
 *
 * Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(Testing.layer()))).then(console.log)
 * // [ 'Create' ]
 * ```
 *
 * @category combinators
 * @since 0.6.0
 */
export const collectChanges = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
  n: number
): Effect.Effect<Effect.Effect<Array<A>, E>, never, R | Scope.Scope> =>
  Stream.runCollect(Stream.take(stream, n)).pipe(
    Effect.forkScoped({ startImmediately: true }),
    Effect.map(Fiber.join)
  )

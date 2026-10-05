/**
 * Observes or rejects selected Effect FileSystem calls before real operations.
 *
 * @since 0.9.0
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import { dual } from "effect/Function"
import type * as PlatformError from "effect/PlatformError"

type Methods = Omit<Parameters<typeof FileSystem.make>[0], "watch">

/**
 * Optional handlers with the original method arguments and scope requirements.
 * Success delegates to the real operation; failure prevents delegation.
 * Handlers run once per execution, before the backing method is called.
 *
 * Derived helpers route through these handlers: `exists` through `access`,
 * `readFileString` through `readFile`, `writeFileString` through `writeFile`,
 * and consumed streams and sinks through `open`.
 *
 * Returned file handles and `watch` are unchanged. Internal calls made by the
 * backing service, including temporary-resource cleanup, bypass these handlers.
 * A write spy counts public write calls, not every filesystem mutation.
 *
 * @example
 * ```ts
 * import { FileSystemTesting } from "@effect-vfs/memory"
 * import { Effect, PlatformError } from "effect"
 *
 * const handlers: FileSystemTesting.Handlers = {
 *   writeFile: (path) => path === "/blocked"
 *     ? Effect.fail(PlatformError.systemError({
 *       _tag: "Unknown", module: "FileSystem", method: "writeFile",
 *       pathOrDescriptor: path, description: "Injected failure"
 *     }))
 *     : Effect.void
 * }
 * ```
 *
 * @category models
 * @since 0.9.0
 */
export type Handlers = {
  readonly [K in keyof Omit<Parameters<typeof FileSystem.make>[0], "watch">]?: (
    ...args: Parameters<Methods[K]>
  ) => Effect.Effect<void, PlatformError.PlatformError, Effect.Services<ReturnType<Methods[K]>>>
}

/**
 * Handlers and test-owned state allocated by the factory for one service build.
 *
 * @example
 * ```ts
 * import { FileSystemTesting } from "@effect-vfs/memory"
 * import { Effect, Ref } from "effect"
 *
 * const factory = Effect.fnUntraced(function*() {
 *   const writes = yield* Ref.make(0)
 *   return {
 *     state: writes,
 *     handlers: { writeFile: () => Ref.update(writes, (count) => count + 1) }
 *   } satisfies FileSystemTesting.Configuration<Ref.Ref<number>>
 * })
 * ```
 *
 * @category models
 * @since 0.9.0
 */
export interface Configuration<State> {
  readonly handlers: Handlers
  readonly state: State
}

/**
 * A decorated service and the factory's state for assertions.
 *
 * @example
 * ```ts
 * import { FileSystemTesting } from "@effect-vfs/memory"
 * import type { Ref } from "effect"
 *
 * const counter = (built: FileSystemTesting.Built<Ref.Ref<number>>) => built.state
 * ```
 *
 * @category models
 * @since 0.9.0
 */
export interface Built<State> {
  readonly fileSystem: FileSystem.FileSystem
  readonly state: State
}

const intercept = <Args extends Array<unknown>, A, R>(
  operation: (...args: Args) => Effect.Effect<A, PlatformError.PlatformError, R>,
  handler: ((...args: Args) => Effect.Effect<void, PlatformError.PlatformError, R>) | undefined
): (...args: Args) => Effect.Effect<A, PlatformError.PlatformError, R> =>
  handler === undefined ?
    operation :
    (...args) => Effect.suspend(() => Effect.andThen(handler(...args), Effect.suspend(() => operation(...args))))

/**
 * Builds a decorator over any Effect FileSystem, including host services.
 *
 * The factory runs once each time this constructor Effect executes. Allocate
 * counters inside the factory for independent builds. Reusing a built service
 * shares its state; capturing an external counter deliberately shares that
 * counter even across builds. Normal Layer memoization also shares a build.
 *
 * Helpers are rebuilt with `FileSystem.make`, replacing any custom derived
 * helpers on the supplied service with Effect's standard implementations.
 * Handler failures preserve their typed errors. Delegated operations retain
 * their interruption and scope ownership. Rejection before delegation cannot
 * simulate partial writes or crashes.
 *
 * @example
 * ```ts
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { FileSystemTesting, MemoryFileSystem } from "@effect-vfs/memory"
 * import { Effect, Ref } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const base = yield* MemoryFileSystem.make
 *   const { fileSystem, state } = yield* FileSystemTesting.make(base, Effect.fnUntraced(function*() {
 *     const writes = yield* Ref.make(0)
 *     return {
 *       state: writes,
 *       handlers: { writeFile: () => Ref.update(writes, (count) => count + 1) }
 *     }
 *   }))
 *   yield* fileSystem.writeFileString("/manifest.json", "{}")
 *   return yield* Ref.get(state)
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // 1
 * ```
 *
 * @category constructors
 * @since 0.9.0
 */
export const make: {
  <State, E, R>(
    factory: () => Effect.Effect<Configuration<State>, E, R>
  ): (base: FileSystem.FileSystem) => Effect.Effect<Built<State>, E, R>
  <State, E, R>(
    base: FileSystem.FileSystem,
    factory: () => Effect.Effect<Configuration<State>, E, R>
  ): Effect.Effect<Built<State>, E, R>
} = dual(
  2,
  Effect.fnUntraced(function*<State, E, R>(
    base: FileSystem.FileSystem,
    factory: () => Effect.Effect<Configuration<State>, E, R>
  ): Effect.fn.Return<Built<State>, E, R> {
    const { handlers, state } = yield* factory()

    const fileSystem = FileSystem.make({
      access: intercept(base.access, handlers.access),
      copy: intercept(base.copy, handlers.copy),
      copyFile: intercept(base.copyFile, handlers.copyFile),
      chmod: intercept(base.chmod, handlers.chmod),
      chown: intercept(base.chown, handlers.chown),
      glob: intercept(base.glob, handlers.glob),
      link: intercept(base.link, handlers.link),
      makeDirectory: intercept(base.makeDirectory, handlers.makeDirectory),
      makeTempDirectory: intercept(base.makeTempDirectory, handlers.makeTempDirectory),
      makeTempDirectoryScoped: intercept(base.makeTempDirectoryScoped, handlers.makeTempDirectoryScoped),
      makeTempFile: intercept(base.makeTempFile, handlers.makeTempFile),
      makeTempFileScoped: intercept(base.makeTempFileScoped, handlers.makeTempFileScoped),
      open: intercept(base.open, handlers.open),
      readDirectory: intercept(base.readDirectory, handlers.readDirectory),
      readFile: intercept(base.readFile, handlers.readFile),
      readLink: intercept(base.readLink, handlers.readLink),
      realPath: intercept(base.realPath, handlers.realPath),
      remove: intercept(base.remove, handlers.remove),
      rename: intercept(base.rename, handlers.rename),
      stat: intercept(base.stat, handlers.stat),
      symlink: intercept(base.symlink, handlers.symlink),
      truncate: intercept(base.truncate, handlers.truncate),
      utimes: intercept(base.utimes, handlers.utimes),
      writeFile: intercept(base.writeFile, handlers.writeFile),
      watch: base.watch
    })

    return { fileSystem, state }
  })
)

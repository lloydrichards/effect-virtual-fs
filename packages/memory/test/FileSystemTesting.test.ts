import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { assert, describe, it } from "@effect/vitest"
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  PlatformError,
  Ref,
  Stream
} from "effect"
import * as FileSystemTesting from "../src/FileSystemTesting.js"
import * as MemoryFileSystem from "../src/MemoryFileSystem.js"

const memoryLayer = MemoryFileSystem.layer.pipe(Layer.provideMerge(NodeCrypto.layer))

const encoder = new TextEncoder()

class SharedBuild
  extends Context.Service<SharedBuild, FileSystemTesting.Built<Ref.Ref<number>>>()("test/SharedBuild")
{}

class FirstConsumer
  extends Context.Service<FirstConsumer, FileSystemTesting.Built<Ref.Ref<number>>>()("test/FirstConsumer")
{}

class SecondConsumer
  extends Context.Service<SecondConsumer, FileSystemTesting.Built<Ref.Ref<number>>>()("test/SecondConsumer")
{}

const injected = PlatformError.systemError({
  _tag: "Unknown",
  module: "FileSystem",
  method: "writeFile",
  description: "Injected failure"
})

const writeCounter = Effect.fnUntraced(function*() {
  const writes = yield* Ref.make(0)

  return {
    state: writes,
    handlers: { writeFile: () => Ref.update(writes, (count) => count + 1) }
  }
})

it.layer(memoryLayer)("FileSystemTesting", (it) => {
  it.effect("should delegate unhandled calls and change the backing state", () =>
    Effect.gen(function*() {
      const base = yield* FileSystem.FileSystem

      const { fileSystem } = yield* FileSystemTesting.make(
        base,
        () => Effect.succeed({ handlers: {}, state: undefined })
      )

      yield* fileSystem.makeDirectory("/delegated")
      yield* fileSystem.writeFileString("/delegated/source", "real bytes")
      yield* fileSystem.rename("/delegated/source", "/delegated/output")
      assert.strictEqual(yield* base.readFileString("/delegated/output"), "real bytes")
      assert.isFalse(yield* base.exists("/delegated/source"))

      yield* fileSystem.remove("/delegated", { recursive: true })
      assert.isFalse(yield* base.exists("/delegated"))
      const original = yield* Effect.flip(base.readFile("/delegated/missing"))
      const delegated = yield* Effect.flip(fileSystem.readFile("/delegated/missing"))
      assert.strictEqual(delegated.reason._tag, original.reason._tag)
      assert.strictEqual(delegated.reason.method, original.reason.method)
    }))

  it.effect("should run string-write spies once per execution and preserve write arguments", () =>
    Effect.gen(function*() {
      const base = yield* FileSystem.FileSystem
      const calls = yield* Ref.make<Array<Parameters<FileSystem.FileSystem["writeFile"]>>>([])

      const { fileSystem } = yield* FileSystemTesting.make(base, () =>
        Effect.succeed({
          state: calls,
          handlers: { writeFile: (...args) => Ref.update(calls, (previous) => [...previous, args]) }
        }))

      const options = { mode: 0o600 }
      const write = fileSystem.writeFileString("/observed", "hello", options)

      assert.deepStrictEqual(yield* Ref.get(calls), [])
      assert.isFalse(yield* base.exists("/observed"))
      yield* write
      yield* write

      const observed = yield* Ref.get(calls)
      assert.strictEqual(observed.length, 2)
      assert.strictEqual(observed[0]?.[0], "/observed")
      assert.deepStrictEqual(observed[0]?.[1], encoder.encode("hello"))
      assert.strictEqual(observed[0]?.[2], options)
      assert.strictEqual(yield* base.readFileString("/observed"), "hello")
      assert.strictEqual((yield* base.stat("/observed")).mode & 0o777, 0o600)
    }))

  it.effect("should route existence and string reads through their primitive handlers", () =>
    Effect.gen(function*() {
      const base = yield* FileSystem.FileSystem
      yield* base.writeFileString("/helper-input", "input")
      const calls = yield* Ref.make<Array<string>>([])

      const { fileSystem } = yield* FileSystemTesting.make(base, () =>
        Effect.succeed({
          state: calls,
          handlers: {
            access: (path) => Ref.update(calls, (previous) => [...previous, `access:${path}`]),
            readFile: (path) => Ref.update(calls, (previous) => [...previous, `readFile:${path}`])
          }
        }))

      assert.isTrue(yield* fileSystem.exists("/helper-input"))
      assert.isFalse(yield* fileSystem.exists("/helper-missing"))
      assert.strictEqual(yield* fileSystem.readFileString("/helper-input"), "input")
      assert.deepStrictEqual(yield* Ref.get(calls), [
        "access:/helper-input",
        "access:/helper-missing",
        "readFile:/helper-input"
      ])
    }))

  it.effect("should leave a rejected write unapplied while earlier writes remain readable", () =>
    Effect.gen(function*() {
      const base = yield* FileSystem.FileSystem
      yield* base.writeFileString("/keep-original", "original")

      const { fileSystem, state } = yield* FileSystemTesting.make(
        base,
        Effect.fnUntraced(function*() {
          const writes = yield* Ref.make(0)

          return {
            state: writes,
            handlers: {
              writeFile: () =>
                Ref.updateAndGet(writes, (count) => count + 1).pipe(
                  Effect.flatMap((count) => count === 2 ? Effect.fail(injected) : Effect.void)
                )
            }
          }
        })
      )

      yield* fileSystem.writeFileString("/earlier-write", "completed")
      const failure = yield* Effect.flip(fileSystem.writeFileString("/keep-original", "rejected"))

      assert.strictEqual(failure, injected)
      assert.strictEqual(yield* Ref.get(state), 2)
      assert.strictEqual(yield* base.readFileString("/earlier-write"), "completed")
      assert.strictEqual(yield* base.readFileString("/keep-original"), "original")
    }))

  it.effect("should allocate independent counters when the same constructor executes twice", () =>
    Effect.gen(function*() {
      const base = yield* FileSystem.FileSystem
      const builds = yield* Ref.make(0)

      const build = FileSystemTesting.make(base, () =>
        Ref.update(builds, (count) => count + 1).pipe(
          Effect.andThen(writeCounter())
        ))

      assert.strictEqual(yield* Ref.get(builds), 0)
      const first = yield* build
      assert.strictEqual(yield* Ref.get(builds), 1)
      const second = yield* build
      assert.strictEqual(yield* Ref.get(builds), 2)

      yield* first.fileSystem.writeFileString("/first-build", "one")
      assert.strictEqual(yield* Ref.get(first.state), 1)
      assert.strictEqual(yield* Ref.get(second.state), 0)
      yield* second.fileSystem.writeFileString("/second-build", "two")
      assert.strictEqual(yield* Ref.get(first.state), 1)
      assert.strictEqual(yield* Ref.get(second.state), 1)
      assert.strictEqual(yield* first.fileSystem.readFileString("/second-build"), "two")
    }))

  it.effect("should share one counter across consumers of a memoized layer build", () =>
    Effect.gen(function*() {
      const base = yield* FileSystem.FileSystem
      const builds = yield* Ref.make(0)

      const shared = Layer.effect(
        SharedBuild,
        Effect.gen(function*() {
          yield* Ref.update(builds, (count) => count + 1)

          return yield* FileSystemTesting.make(base, writeCounter)
        })
      )

      const first = Layer.effect(FirstConsumer, SharedBuild).pipe(Layer.provide(shared))
      const second = Layer.effect(SecondConsumer, SharedBuild).pipe(Layer.provide(shared))

      yield* Effect.gen(function*() {
        const one = yield* FirstConsumer
        const two = yield* SecondConsumer
        assert.strictEqual(one, two)
        yield* one.fileSystem.writeFileString("/shared-one", "one")
        yield* two.fileSystem.writeFileString("/shared-two", "two")
        assert.strictEqual(yield* Ref.get(one.state), 2)
        assert.strictEqual(yield* Ref.get(two.state), 2)
      }).pipe(Effect.provide(Layer.merge(first, second)))
      assert.strictEqual(yield* Ref.get(builds), 1)
    }))

  it.effect("should interrupt a blocked handler before invoking the backing operation", () =>
    Effect.gen(function*() {
      const base = yield* FileSystem.FileSystem
      const entered = yield* Deferred.make<void>()

      const { fileSystem } = yield* FileSystemTesting.make(base, () =>
        Effect.succeed({
          state: undefined,
          handlers: { writeFile: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)) }
        }))

      const fiber = yield* fileSystem.writeFileString("/interrupted-write", "never applied").pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)

      assert.isTrue(Exit.isFailure(exit))

      if (Exit.isSuccess(exit)) return
      assert.isTrue(Cause.hasInterrupts(exit.cause))
      assert.isFalse(yield* base.exists("/interrupted-write"))
    }))

  it.effect("should intercept stream and sink acquisition only when consumed", () =>
    Effect.gen(function*() {
      const base = yield* FileSystem.FileSystem
      yield* base.writeFileString("/stream-input", "abcdef")
      const opens = yield* Ref.make<Array<string>>([])
      const writes = yield* Ref.make(0)

      const { fileSystem } = yield* FileSystemTesting.make(base, () =>
        Effect.succeed({
          state: opens,
          handlers: {
            open: (path) => Ref.update(opens, (previous) => [...previous, path]),
            writeFile: () => Ref.update(writes, (count) => count + 1)
          }
        }))

      const stream = fileSystem.stream("/stream-input", { chunkSize: 2 })
      const sink = fileSystem.sink("/sink-output")
      assert.deepStrictEqual(yield* Ref.get(opens), [])

      const chunks = yield* Stream.runCollect(stream)
      assert.strictEqual(chunks.map((chunk) => new TextDecoder().decode(chunk)).join(""), "abcdef")
      yield* Stream.run(Stream.make(encoder.encode("one"), encoder.encode("two")), sink)
      assert.deepStrictEqual(yield* Ref.get(opens), ["/stream-input", "/sink-output"])
      assert.strictEqual(yield* Ref.get(writes), 0)
      assert.strictEqual(yield* base.readFileString("/sink-output"), "onetwo")
    }))

  it.effect("should preserve open failures through streams and sinks without acquiring a file", () =>
    Effect.gen(function*() {
      const base = yield* FileSystem.FileSystem

      const { fileSystem } = yield* FileSystemTesting.make(base, () =>
        Effect.succeed({
          state: undefined,
          handlers: { open: () => Effect.fail(injected) }
        }))

      assert.strictEqual(yield* Effect.flip(Stream.runDrain(fileSystem.stream("/rejected-stream"))), injected)
      assert.strictEqual(
        yield* Effect.flip(Stream.run(Stream.make(encoder.encode("bytes")), fileSystem.sink("/rejected-sink"))),
        injected
      )
      assert.isFalse(yield* base.exists("/rejected-sink"))
    }))

  it.effect("should keep scoped temporary cleanup outside a failing remove handler", () =>
    Effect.gen(function*() {
      const base = yield* FileSystem.FileSystem
      const removes = yield* Ref.make(0)
      const creations = yield* Ref.make(0)

      const { fileSystem } = yield* FileSystemTesting.make(base, () =>
        Effect.succeed({
          state: removes,
          handlers: {
            remove: () => Ref.update(removes, (count) => count + 1).pipe(Effect.andThen(Effect.fail(injected))),
            makeTempFileScoped: () => Ref.update(creations, (count) => count + 1),
            makeTempDirectoryScoped: () => Ref.update(creations, (count) => count + 1)
          }
        }))

      const paths = yield* Effect.scoped(Effect.gen(function*() {
        const file = yield* fileSystem.makeTempFileScoped()
        const directory = yield* fileSystem.makeTempDirectoryScoped()
        assert.isTrue(yield* base.exists(file))
        assert.isTrue(yield* base.exists(directory))

        return [file, directory]
      }))

      for (const path of paths) assert.isFalse(yield* base.exists(path))
      assert.strictEqual(yield* Ref.get(creations), 2)
      assert.strictEqual(yield* Ref.get(removes), 0)
      assert.strictEqual(yield* Effect.flip(fileSystem.remove("/anything")), injected)
      assert.strictEqual(yield* Ref.get(removes), 1)
    }))

  describe("delegated file lifetime", () => {
    it.effect.each(
      [
        { kind: "stream", outcome: "success" },
        { kind: "stream", outcome: "failure" },
        { kind: "stream", outcome: "interruption" },
        { kind: "sink", outcome: "success" },
        { kind: "sink", outcome: "failure" },
        { kind: "sink", outcome: "interruption" }
      ] as const
    )(
      "should close a delegated $kind handle after $outcome",
      ({ kind, outcome }) =>
        Effect.gen(function*() {
          const base = yield* FileSystem.FileSystem
          yield* base.writeFileString(`/lifetime-${outcome}`, "bytes")
          const opened = yield* Deferred.make<void>()
          const handle = yield* Ref.make<Option.Option<FileSystem.File>>(Option.none())

          const tracked = FileSystem.make({
            ...base,
            open: (path, options) =>
              base.open(path, options).pipe(
                Effect.tap((file) => Ref.set(handle, Option.some(file))),
                Effect.tap(() => Deferred.succeed(opened, undefined))
              )
          })

          const { fileSystem } = yield* FileSystemTesting.make(tracked, () =>
            Effect.succeed({
              state: undefined,
              handlers: { open: () => Effect.void }
            }))

          const stream = fileSystem.stream(`/lifetime-${outcome}`)

          const operation = kind === "stream"
            ? Stream.runForEach(stream, () =>
              outcome === "interruption"
                ? Effect.never
                : outcome === "failure"
                ? Effect.fail(injected)
                : Effect.void)
            : Stream.run(
              Stream.fromEffect(
                outcome === "interruption"
                  ? Effect.never
                  : outcome === "failure"
                  ? Effect.fail(injected)
                  : Effect.succeed(encoder.encode("written"))
              ),
              fileSystem.sink(`/lifetime-sink-${outcome}`)
            )

          if (outcome === "interruption") {
            const fiber = yield* operation.pipe(Effect.forkChild)
            yield* Deferred.await(opened)
            yield* Fiber.interrupt(fiber)
          } else if (outcome === "failure") {
            assert.strictEqual(yield* Effect.flip(operation), injected)
          } else {
            yield* operation
          }

          const file = Option.getOrThrow(yield* Ref.get(handle))
          const failure = yield* Effect.flip(file.stat)
          assert.strictEqual(failure.reason._tag, "BadResource")
        })
    )
  })
})

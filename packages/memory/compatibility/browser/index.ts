import { Crypto, Effect, Layer, Ref } from "effect"
import { FileSystemTesting, MemoryFileSystem } from "../../dist/index.js"

const cryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: () => Effect.die("digest is not used by the compatibility smoke test")
  })
)

// Keep a real operation reachable so the browser build cannot pass with a discarded implementation.
export const smoke = () =>
  Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* MemoryFileSystem.make

      const { fileSystem, state } = yield* FileSystemTesting.make(
        fs,
        Effect.fnUntraced(function*() {
          const writes = yield* Ref.make(0)

          return { state: writes, handlers: { writeFile: () => Ref.update(writes, (count) => count + 1) } }
        })
      )

      yield* fileSystem.writeFileString("/smoke", "browser bundle")

      return `${yield* fs.readFileString("/smoke")}:${yield* Ref.get(state)}`
    }).pipe(Effect.provide(cryptoLayer))
  )

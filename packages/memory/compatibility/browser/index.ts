import { Crypto, Effect, Layer } from "effect"
import { MemoryFileSystem } from "../../dist/index.js"

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
      yield* fs.writeFileString("/smoke", "browser bundle")

      return yield* fs.readFileString("/smoke")
    }).pipe(Effect.provide(cryptoLayer))
  )

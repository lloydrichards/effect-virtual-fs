import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"

export const layer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.tryPromise({
        try: () => crypto.subtle.digest(algorithm, Uint8Array.from(data)),
        catch: (cause) =>
          PlatformError.systemError({
            _tag: "Unknown",
            module: "Crypto",
            method: "digest",
            cause
          })
      }).pipe(Effect.map((digest) => new Uint8Array(digest)))
  })
)

/**
 * Ownership and validation policy for whole-image stores.
 *
 * @internal
 * @since 0.11.1
 */
import { LiveVolume, type VfsError, type VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { ByteSize, Cause, Data, Effect, Exit, Predicate, Ref, Schema } from "effect"
import { makeDigest, type StoreFailures } from "./storeSupport.js"

/**
 * Raw metadata remains untrusted until the protocol admits the image.
 *
 * @internal
 */
export interface ImageRecord<Token> {
  readonly image: Uint8Array
  readonly generation: unknown
  readonly digest: unknown
  readonly token: Token
}

/**
 * Protocol-prepared bytes and metadata that the adapter serializes without revalidating.
 *
 * @internal
 */
export interface Image {
  readonly image: Uint8Array
  readonly generation: number
  readonly digest: string
}

/**
 * Backend certainty about a conditional write; only Written advances the ownership token.
 *
 * @internal
 */
export type WriteResult<Token> =
  | { readonly _tag: "Written"; readonly token: Token }
  | { readonly _tag: "Rejected"; readonly cause?: unknown }
  | { readonly _tag: "Conflict" }
  | { readonly _tag: "Unknown"; readonly cause?: unknown }

interface WriteResultDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: WriteResult<this["A"]>
}

/**
 * Constructs backend outcomes separately from the public CommitOutcome values.
 *
 * @internal
 */
export const WriteResult = Data.taggedEnum<WriteResultDefinition>()

const CommitResult = Data.taggedEnum<Exclude<LiveVolume.CommitOutcome, string>>()

/**
 * Adapters own format decoding and cleanup. Absence means a genuinely uninitialized store.
 *
 * @internal
 */
export interface Storage<Token> {
  readonly read: Effect.Effect<ImageRecord<Token> | null, VfsError.StoreFailure>
  /** Undefined means create only. Tokens themselves must be defined. */
  readonly compareAndSwap: (expected: Token | undefined, next: Image) => Effect.Effect<WriteResult<Token>>
}

interface Ownership<Token> {
  readonly available: boolean
  readonly initializing: boolean
  readonly current: { readonly generation: number; readonly token: Token } | undefined
}

type Restore = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>

const Generation = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))

const DecimalGeneration = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]*)$/))

const StoredGeneration = Schema.Union([Generation, DecimalGeneration])

const StoredDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))

/**
 * Validate the shared size bound before adapters convert it to numeric storage parameters.
 *
 * @internal
 */
export const imageLimit = Effect.fnUntraced(function*(
  bytes: ByteSize.ByteSize,
  failures: StoreFailures,
  field = "maxImageBytes"
) {
  const limit = ByteSize.toBigInt(bytes)

  if (limit <= 0n || limit > BigInt(Number.MAX_SAFE_INTEGER)) return yield* failures.invalid(field)

  return limit
})

/**
 * Creates one owner with atomic initialization and a freeze that later acknowledgements cannot clear.
 *
 * @internal
 */
export const make = Effect.fnUntraced(function*<Token>(options: {
  readonly maxImage: bigint
  readonly loading: StoreFailures
  readonly storage: Storage<Token>
  readonly durability?: Vfs.VolumeDurability
}) {
  const { loading, maxImage, storage } = options
  const digest = yield* makeDigest
  const ownership = yield* Ref.make<Ownership<Token>>({ available: true, initializing: false, current: undefined })
  const freeze = Ref.update(ownership, (state) => ({ ...state, available: false }))

  const validate = Effect.fnUntraced(function*(record: ImageRecord<Token>, restore: Restore) {
    const stored = yield* Schema.decodeUnknownEffect(StoredGeneration)(record.generation).pipe(
      Effect.mapError((cause) => loading.fail("CorruptStore", cause))
    )

    const generation = yield* Schema.decodeEffect(Generation)(Number(stored)).pipe(
      Effect.mapError((cause) => loading.fail("CorruptStore", cause))
    )

    const hash = yield* Schema.decodeUnknownEffect(StoredDigest)(record.digest).pipe(
      Effect.mapError((cause) => loading.fail("CorruptStore", cause))
    )

    if (BigInt(record.image.length) > maxImage) return yield* loading.fail("CorruptStore")
    const actual = yield* restore(digest(record.image))

    if (actual !== hash) return yield* loading.fail("CorruptStore")
    yield* Ref.update(ownership, (state) => ({ ...state, current: { generation, token: record.token } }))

    return new Uint8Array(record.image)
  })

  const write = Effect.fnUntraced(function*(expected: Token | undefined, next: Image, restore: Restore) {
    const written = yield* Effect.exit(restore(Effect.suspend(() => storage.compareAndSwap(expected, next))))

    if (Exit.isFailure(written)) {
      yield* freeze

      if (Cause.hasInterrupts(written.cause)) return yield* Effect.failCause(written.cause)

      return WriteResult.Unknown({ cause: written.cause })
    }

    const result = written.value

    if (Predicate.isTagged(result, "Written")) {
      // A late acknowledgement must retain a freeze set by another in-flight write.
      yield* Ref.update(ownership, (state) => ({
        ...state,
        current: { generation: next.generation, token: result.token }
      }))
    } else if (
      Predicate.isTagged(result, "Unknown") || (Predicate.isTagged(result, "Conflict") && expected !== undefined)
    ) {
      yield* freeze
    }

    return result
  })

  const store = LiveVolume.LiveImageStore.of({
    durability: options.durability ?? "memory-only",
    loadOrCreate: Effect.fnUntraced(function*(initial: Uint8Array) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function*() {
          const claimed = yield* Ref.modify(ownership, (state) => {
            if (!state.available) return ["Storage", state] as const

            if (state.initializing || state.current !== undefined) return ["Ownership", state] as const

            return ["Claimed", { ...state, initializing: true }] as const
          })

          if (claimed !== "Claimed") return yield* loading.fail(claimed)
          let attemptedWrite = false

          return yield* Effect.gen(function*() {
            const existing = yield* restore(storage.read)

            if (existing !== null) return yield* validate(existing, restore)

            if (BigInt(initial.length) > maxImage) return yield* loading.invalid("maxImageBytes")
            const hash = yield* restore(digest(initial))
            attemptedWrite = true
            const created = yield* write(undefined, { image: initial, generation: 0, digest: hash }, restore)

            if (Predicate.isTagged(created, "Written")) return new Uint8Array(initial)

            if (Predicate.isTagged(created, "Conflict")) {
              const winner = yield* restore(storage.read)

              if (winner !== null) return yield* validate(winner, restore)
            }

            return yield* loading.fail("Storage", "cause" in created ? created.cause : undefined)
          }).pipe(
            Effect.onInterrupt(() => attemptedWrite ? freeze : Effect.void),
            Effect.ensuring(Ref.update(ownership, (state) => ({ ...state, initializing: false })))
          )
        })
      )
    }),
    commit: Effect.fnUntraced(function*(image: Uint8Array) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function*() {
          const { available, current } = yield* Ref.get(ownership)

          if (!available || current === undefined) return "unknown" as const

          if (
            BigInt(image.length) > maxImage || current.generation === Number.MAX_SAFE_INTEGER
          ) return "rejected" as const
          const hashing = yield* Effect.exit(restore(digest(image)))

          if (Exit.isFailure(hashing)) {
            if (Cause.hasInterrupts(hashing.cause)) return yield* Effect.failCause(hashing.cause)

            return CommitResult.Rejected({ cause: hashing.cause })
          }

          // Hashing can suspend while another operation freezes this owner.
          if (!(yield* Ref.get(ownership)).available) return "unknown" as const

          const result = yield* write(current.token, {
            image,
            generation: current.generation + 1,
            digest: hashing.value
          }, restore)

          if (Predicate.isTagged(result, "Written")) return "committed" as const

          if (Predicate.isTagged(result, "Rejected")) return "rejected" as const

          return "unknown" as const
        })
      )
    })
  })

  return { store, isAvailable: Ref.get(ownership).pipe(Effect.map((state) => state.available)) }
})

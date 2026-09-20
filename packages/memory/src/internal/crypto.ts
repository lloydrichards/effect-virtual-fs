/**
 * Provides the deterministic `Crypto` implementation used by the in-memory
 * filesystem when no platform crypto is supplied.
 *
 * The values are reproducible pseudo-random bytes, not cryptographically
 * secure ones. They exist so that an in-memory volume can mint its identity
 * and incarnation without pulling a platform dependency into a test.
 *
 * @internal
 * @since 0.1.0
 */
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const SEED = 0x9e3779b97f4a7c15n
const MULTIPLIER = 0xbf58476d1ce4e5b9n
const SCRAMBLER = 0x94d049bb133111ebn
const MASK_64 = 0xffffffffffffffffn
const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x00000100000001b3n

const DIGEST_SIZE: Record<Crypto.DigestAlgorithm, number> = {
  "SHA-1": 20,
  "SHA-256": 32,
  "SHA-384": 48,
  "SHA-512": 64
}

// SplitMix64: a small, well-distributed generator with no platform dependency.
const splitMix64 = (state: bigint) => {
  let next = (state + SEED) & MASK_64

  next = ((next ^ (next >> 30n)) * MULTIPLIER) & MASK_64
  next = ((next ^ (next >> 27n)) * SCRAMBLER) & MASK_64

  return next ^ (next >> 31n)
}

const fill = (size: number, next: () => bigint) => {
  const bytes = new Uint8Array(size)

  for (let index = 0; index < size; index += 8) {
    let word = next()

    for (let offset = 0; offset < 8 && index + offset < size; offset++) {
      bytes[index + offset] = Number(word & 0xffn)
      word >>= 8n
    }
  }

  return bytes
}

// One counter per module instance keeps every volume in a process distinct,
// including volumes built from separate layer graphs.
let counter = 0n

/**
 * Creates a deterministic `Crypto` service.
 *
 * Successive calls continue one shared sequence, so every volume receives its
 * own identity and incarnation without a platform source of randomness.
 *
 * @internal
 */
export const makeDeterministicCrypto = (): Crypto.Crypto => {
  const next = () => splitMix64(counter++)

  return Crypto.make({
    randomBytes: (size) => fill(size, next),
    digest: (algorithm, data) =>
      Effect.sync(() => {
        let hash = FNV_OFFSET

        for (const byte of data) hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK_64

        let counter = hash

        return fill(DIGEST_SIZE[algorithm], () => (counter = splitMix64(counter)))
      })
  })
}

/** @internal */
export const layerDeterministicCrypto: Layer.Layer<Crypto.Crypto> = Layer.sync(Crypto.Crypto, makeDeterministicCrypto)

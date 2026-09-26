import * as Encoding from "effect/Encoding"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { ENCODING_CHECK } from "./errors.js"

const canonicalTail = /^(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?(?![\s\S])/

const isCanonical = (value: string): boolean =>
  value.length % 4 === 0 &&
  !/[^A-Za-z0-9+/]/.test(value.slice(0, -4)) &&
  canonicalTail.test(value.slice(-4))

const decodedLength = (value: string): number =>
  value.length / 4 * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0)

const encode = (input: Uint8Array): Encoded => {
  // Join bounded chunks to avoid the encoder's intermediate string chains. Three-byte
  // boundaries keep padding in the final chunk, preserving the canonical representation.
  const chunkBytes = 12_288
  const chunks: Array<string> = []

  for (let offset = 0; offset < input.length; offset += chunkBytes) {
    chunks.push(Encoding.encodeBase64(input.subarray(offset, offset + chunkBytes)))
  }

  return Encoded.make(chunks.join(""))
}

const Encoded = Schema.String.pipe(
  Schema.refine((value): value is string => isCanonical(value), {
    expected: "canonical padded base64",
    [ENCODING_CHECK]: true
  }),
  Schema.brand("CanonicalBase64")
)

type Encoded = typeof Encoded.Type

/** @internal */
export const CanonicalBase64 = {
  Encoded,
  // A canonical value always decodes, so a synchronous caller need not handle a failure.
  toBytes: (input: Encoded): Uint8Array => Result.getOrThrow(Encoding.decodeBase64(input)),
  encode: (input: Uint8Array): Encoded => encode(input),
  decodedLength: (value: Encoded): number => decodedLength(value)
}

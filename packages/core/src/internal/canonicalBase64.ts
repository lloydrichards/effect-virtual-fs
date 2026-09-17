import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"

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
  Schema.refine((value): value is string => isCanonical(value), { expected: "canonical padded base64" }),
  Schema.brand("CanonicalBase64")
)

const Bytes = Encoded.pipe(
  Schema.decodeTo(Schema.Uint8Array, {
    decode: SchemaGetter.decodeBase64<Encoded>(),
    encode: SchemaGetter.transform<Encoded, Uint8Array>((input) => encode(input))
  })
)

type Encoded = typeof Encoded.Type

/** @internal */
export const CanonicalBase64 = {
  Encoded,
  Bytes,
  decode: (input: Encoded) => Schema.decodeEffect(Bytes)(input).pipe(Effect.orDie),
  encode: (input: Uint8Array): Encoded => encode(input),
  decodedLength: (value: Encoded): number => decodedLength(value),
  is: (value: string): value is Encoded => isCanonical(value)
}

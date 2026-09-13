import * as Encoding from "effect/Encoding"
import * as Result from "effect/Result"

const canonicalTail = /^(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?(?![\s\S])/

/** @internal */
export const isCanonical = (value: string): boolean =>
  value.length % 4 === 0 &&
  !/[^A-Za-z0-9+/]/.test(value.slice(0, -4)) &&
  canonicalTail.test(value.slice(-4))

/** @internal */
export const decodedLength = (value: string): number =>
  value.length / 4 * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0)

/** @internal */
export const decodeTrusted = (value: string): Uint8Array =>
  Result.getOrThrowWith(Encoding.decodeBase64(value), () => new Error("Invalid trusted canonical base64"))

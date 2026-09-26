import { assert, describe, it } from "@effect/vitest"
import { Encoding, Result } from "effect"
import { hmacSha256, sameTag } from "../src/internal/hmac.js"

const hex = (text: string) => Result.getOrThrow(Encoding.decodeHex(text))

const ascii = (text: string) => new TextEncoder().encode(text)

describe("reference-key tag HMAC", () => {
  // RFC 4231 Section 4: cases 1, 2, 3 and 6 cover a short key, a text key, a block of data and a key over one block.
  it("matches the RFC 4231 HMAC-SHA-256 test vectors", () => {
    const cases: ReadonlyArray<readonly [Uint8Array, Uint8Array, string]> = [
      [
        hex("0b".repeat(20)),
        ascii("Hi There"),
        "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
      ],
      [
        ascii("Jefe"),
        ascii("what do ya want for nothing?"),
        "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
      ],
      [
        hex("aa".repeat(20)),
        hex("dd".repeat(50)),
        "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe"
      ],
      [
        hex("aa".repeat(131)),
        ascii("Test Using Larger Than Block-Size Key - Hash Key First"),
        "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
      ]
    ]

    for (const [key, message, expected] of cases) {
      assert.strictEqual(Encoding.encodeHex(hmacSha256(key, message)), expected)
    }
  })

  it("compares tags of equal length byte by byte", () => {
    assert.isTrue(sameTag(hex("00ff"), hex("00ff")))
    assert.isFalse(sameTag(hex("00ff"), hex("01ff")))
    assert.isFalse(sameTag(hex("00ff"), hex("00")))
  })
})

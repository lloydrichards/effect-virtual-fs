import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"

const encodedFile = (data: string) => {
  const metadata = { uid: 0, gid: 0, mode: 0o644, atimeNs: "0", mtimeNs: "0", ctimeNs: "0", birthtimeNs: "0" }
  return new TextEncoder().encode(JSON.stringify({
    format: "effect-vfs",
    version: 1,
    root: "root",
    records: [
      { id: "root", kind: "directory", metadata, entries: [{ name: "Zg==", target: "file" }] },
      { id: "file", kind: "file", metadata, data }
    ]
  }))
}
const limits = { maxEncodedBytes: 17_000_000, maxRecords: 2, maxEntries: 1, maxDecodedBytes: 12_000_001 }

describe("snapshot decoding", () => {
  it.effect("should restore a large canonical payload when it fits the supplied budgets", () =>
    Effect.gen(function*() {
      const snapshot = yield* Vfs.decodeSnapshot(encodedFile("AAAA".repeat(4_000_000)), limits)
      const caller = yield* (yield* Vfs.fromSnapshot(snapshot)).caller()
      assert.strictEqual((yield* caller.stat("/f")).size, 12_000_000n)
      const file = yield* caller.open("/f", { access: "read" })
      assert.deepStrictEqual(yield* file.pread(1, 11_999_999n), new Uint8Array([0]))
    }))

  it.effect("should reject malformed payloads when alphabet, padding or unused bits are noncanonical", () =>
    Effect.gen(function*() {
      for (
        const data of [
          "A",
          "AAAAA",
          "AA=A",
          "=AAA",
          "AA==AAAA",
          "AAAAZh==",
          "AAAAZm9=",
          "AAAAAA==\n",
          "AAAA AA==",
          "AAAAAA-_"
        ]
      ) {
        const error = yield* Effect.flip(Vfs.decodeSnapshot(encodedFile(data), limits))
        assert.instanceOf(error, Vfs.ImageError)
        assert.strictEqual(error.code, "InvalidEncoding", data)
      }
    }))
})

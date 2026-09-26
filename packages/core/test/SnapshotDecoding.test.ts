import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"

const encodedFile = (data: string) => {
  const metadata = { uid: 0, gid: 0, mode: 0o644, atimeNs: "0", mtimeNs: "0", ctimeNs: "0", birthtimeNs: "0" }

  return new TextEncoder().encode(JSON.stringify({
    format: "effect-vfs",
    version: 1,
    nodes: [
      { _tag: "directory", ino: 1, parent: 1, name: "", metadata },
      { _tag: "file", ino: 2, links: [{ parent: 1, name: "Zg==" }], content: { _tag: "Inline", bytes: data }, metadata }
    ]
  }))
}

const limits = {
  maxEncodedBytes: ByteSize.megabytes(17),
  maxRecords: 2,
  maxEntries: 1,
  maxDecodedBytes: ByteSize.bytes(12_000_001)
}

describe("snapshot decoding", () => {
  it.effect("encodes bytes as canonical base64 and decodes that representation", () =>
    Effect.gen(function*() {
      const input = new Uint8Array([0, 255, 127, 42])
      const snapshot = yield* Vfs.decodeSnapshot(encodedFile("AP9/Kg=="), limits)
      const caller = yield* (yield* Vfs.fromSnapshot(snapshot)).caller()

      assert.deepStrictEqual(yield* caller.readFile("/f"), input)
      assert.deepStrictEqual(yield* Vfs.encodeSnapshot(snapshot), encodedFile("AP9/Kg=="))
    }))

  it.effect(
    "should restore a large canonical payload when it fits the supplied budgets",
    () =>
      Effect.gen(function*() {
        const data = "AAAA".repeat(4_000_000)
        const snapshot = yield* Vfs.decodeSnapshot(encodedFile(data), limits)
        const caller = yield* (yield* Vfs.fromSnapshot(snapshot)).caller()
        assert.strictEqual((yield* caller.stat("/f")).size, 12_000_000n)
        const file = yield* caller.open("/f", { access: "read" })
        assert.deepStrictEqual((yield* file.pread(1, 11_999_999n)).bytes, new Uint8Array([0]))
      })
  )

  it.effect(
    "should reject malformed payloads when alphabet, padding or unused bits are noncanonical",
    () =>
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
          assert.instanceOf(error, Vfs.VfsError)
          assert.strictEqual(error.code, "InvalidEncoding", data)
        }
      })
  )
})

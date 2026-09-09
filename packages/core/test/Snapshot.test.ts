import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"

const limits = { maxEncodedBytes: 1_000_000, maxRecords: 100, maxEntries: 100, maxDecodedBytes: 100_000 }
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

describe("fixtures and snapshots", () => {
  it.effect("should preserve canonical payloads and bytes when files span encoding chunks", () =>
    Effect.gen(function*() {
      for (const [tail, suffix] of ["", "AA==", "AP8="].entries()) {
        const input = Uint8Array.from(
          { length: 24_576 + tail },
          (_, index) => index % 3 === 0 ? 0 : index % 3 === 1 ? 255 : 127
        )
        const volume = yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/f", bytes: input }] })
        const encoded = yield* Vfs.encodeSnapshot(yield* volume.snapshot)
        const document = JSON.parse(new TextDecoder().decode(encoded))
        assert.strictEqual(
          document.records.find((record: { kind: string }) => record.kind === "file").data,
          "AP9/".repeat(8_192) + suffix
        )
        const restored = yield* Vfs.fromSnapshot(yield* Vfs.decodeSnapshot(encoded, limits))
        assert.deepStrictEqual(yield* (yield* restored.caller()).readFile("/f"), input)
      }
    }))

  it.effect("loads order-independent fixtures with forward hard links and fixed metadata", () =>
    Effect.gen(function*() {
      const input = new Uint8Array([1, 2])
      const volume = yield* Vfs.fromFixture({
        entries: [
          { kind: "hardLink", path: "/alias", target: "/dir/file" },
          { kind: "file", path: "/dir/file", bytes: input, metadata: { mode: 0o640, uid: 7 } },
          { kind: "directory", path: "/dir" },
          { kind: "symlink", path: "/dangling", target: "absent" }
        ]
      })
      input[0] = 9
      const fs = yield* volume.caller()
      const f = yield* fs.open("/alias", { access: "read" })
      assert.deepStrictEqual(yield* f.read(2), new Uint8Array([1, 2]))
      const stat = yield* fs.stat("/dir/file")
      assert.strictEqual(stat.ino, (yield* f.stat).ino)
      assert.deepStrictEqual([stat.nlink, stat.uid, stat.mode, stat.mtimeNs], [2, 7, 0o640, 0n])
      assert.strictEqual(yield* fs.readLink("/dangling"), "absent")
    }))

  it.effect("isolates capture, encoded bytes and independent restores from subsequent overwrites", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/f", bytes: new Uint8Array([1, 2]) }] })
      const fs = yield* volume.caller()
      const snapshot = yield* volume.snapshot
      const f = yield* fs.open("/f", { access: "write" })
      yield* f.pwrite(new Uint8Array([9]), 0n)
      const bytes = yield* Vfs.encodeSnapshot(snapshot)
      const decoded = yield* Vfs.decodeSnapshot(bytes, limits)
      bytes.fill(0)
      const a = yield* (yield* Vfs.fromSnapshot(decoded)).caller()
      const b = yield* (yield* Vfs.fromSnapshot(decoded)).caller()
      const af = yield* a.open("/f", { access: "readWrite" })
      const bf = yield* b.open("/f", { access: "read" })
      yield* af.write(new Uint8Array([8]))
      assert.deepStrictEqual(yield* bf.read(2), new Uint8Array([1, 2]))
      const byteLimit = yield* Effect.flip(Vfs.fromSnapshot(snapshot, { maxBytes: 1 }))
      assert.instanceOf(byteLimit, Vfs.ImageError)
      assert.strictEqual(byteLimit.code, "LimitExceeded")
      const entryLimit = yield* Effect.flip(Vfs.fromSnapshot(snapshot, { maxEntries: 0 }))
      assert.instanceOf(entryLimit, Vfs.ImageError)
      assert.strictEqual(entryLimit.code, "LimitExceeded")
    }))

  it.effect("preserves byte names and symlink aliases but excludes unlinked-open contents", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const fs = yield* volume.caller()
      const path = yield* Vfs.pathFromBytes(new Uint8Array([47, 255]))
      yield* fs.symlink("", path)
      yield* fs.link(path, "/alias")
      const f = yield* fs.open("/removed", { access: "write", create: "exclusive" })
      yield* f.write(new Uint8Array([1, 2, 3]))
      yield* fs.unlink("/removed")
      const restored = yield* (yield* Vfs.fromSnapshot(yield* volume.snapshot, { maxBytes: 0 })).caller()
      assert.strictEqual((yield* restored.lstat(path)).ino, (yield* restored.lstat("/alias")).ino)
      assert.strictEqual((yield* Effect.flip(restored.stat("/removed"))).code, "NotFound")
      assert.strictEqual(yield* restored.readLink(path), "")
    }))

  it.effect("rejects malformed graphs, unknown fields and noncanonical encodings", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/f", bytes: new Uint8Array([102]) }] })
      const original = JSON.parse(new TextDecoder().decode(yield* Vfs.encodeSnapshot(yield* volume.snapshot)))
      const mutations: Array<(image: typeof original) => void> = [
        (image) => {
          image.extra = true
        },
        (image) => {
          image.records[0].metadata.extra = 1
        },
        (image) => {
          image.records[1].data = "Zh=="
        },
        (image) => {
          image.records[1].metadata.mtimeNs = "01"
        },
        (image) => {
          image.records[1].id = image.records[0].id
        },
        (image) => {
          image.records[0].entries[0].target = "missing"
        },
        (image) => {
          image.records[0].entries.push(image.records[0].entries[0])
        },
        (image) => {
          image.records[0].entries[0].target = image.root
        },
        (image) => {
          image.records[0].entries = []
        }
      ]
      for (const mutate of mutations) {
        const image = structuredClone(original)
        mutate(image)
        yield* Effect.flip(Vfs.decodeSnapshot(encode(image), limits))
      }
      original.version = 2
      assert.strictEqual((yield* Effect.flip(Vfs.decodeSnapshot(encode(original), limits))).code, "UnsupportedVersion")
      assert.strictEqual(
        (yield* Effect.flip(Vfs.decodeSnapshot(new Uint8Array([255]), limits))).code,
        "InvalidEncoding"
      )
      assert.strictEqual(
        (yield* Effect.flip(Vfs.decodeSnapshot(new Uint8Array(10), { ...limits, maxEncodedBytes: 9 }))).code,
        "LimitExceeded"
      )
    }))

  it.effect("captures a complete serial namespace when rename races and enforces decoded budgets", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.fromFixture({
        entries: [{ kind: "file", path: "/before", bytes: new Uint8Array([1, 2, 3]) }]
      })
      const fs = yield* volume.caller()
      const [snapshot] = yield* Effect.all([volume.snapshot, fs.rename("/before", "/after")], {
        concurrency: "unbounded"
      })
      const restored = yield* (yield* Vfs.fromSnapshot(snapshot)).caller()
      const names = yield* restored.readDirectory("/")
      assert.isTrue(names.join() === "before" || names.join() === "after")
      const encoded = yield* Vfs.encodeSnapshot(snapshot)
      for (
        const bound of [{ ...limits, maxRecords: 1 }, { ...limits, maxEntries: 0 }, { ...limits, maxDecodedBytes: 2 }]
      ) {
        assert.strictEqual((yield* Effect.flip(Vfs.decodeSnapshot(encoded, bound))).code, "LimitExceeded")
      }
    }))

  it.effect("rejects fixture collisions, missing parents, hard-link cycles and destination limits", () =>
    Effect.gen(function*() {
      const invalid: Array<Vfs.Fixture> = [
        { entries: [{ kind: "directory", path: "/a/b" }] },
        { entries: [{ kind: "directory", path: "/a" }, { kind: "directory", path: "/a" }] },
        { entries: [{ kind: "hardLink", path: "/a", target: "/b" }, { kind: "hardLink", path: "/b", target: "/a" }] },
        { entries: [{ kind: "directory", path: "/a" }, { kind: "hardLink", path: "/b", target: "/a" }] }
      ]
      for (const fixture of invalid) yield* Effect.flip(Vfs.fromFixture(fixture))
      const limit = yield* Effect.flip(
        Vfs.fromFixture({ entries: [{ kind: "file", path: "/f", bytes: new Uint8Array(2) }] }, { maxBytes: 1 })
      )
      assert.instanceOf(limit, Vfs.ImageError)
      assert.strictEqual(limit.code, "LimitExceeded")
    }))
})

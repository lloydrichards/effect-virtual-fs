import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect, HashMap } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"
import { State, withVolumeTestSeams } from "../src/internal/model.js"
import { file } from "./support/volumeState.js"

const text = new TextEncoder()

it.effect("should retain unlinked bytes and capacity when an open handle outlives every name", () =>
  Effect.gen(function*() {
    const volume = yield* Vfs.make({ maxBytes: ByteSize.bytes(4) })
    const ops = yield* volume.caller({ umask: 0 })
    const bytes = text.encode("data")
    yield* ops.writeFile("/file", bytes, { access: "write", create: "exclusive" })
    bytes.fill(0)
    yield* ops.link("/file", "/alias")
    const handle = yield* ops.open("/file", { access: "readWrite" })
    yield* handle.pwrite(text.encode("D"), 0n)
    assert.deepStrictEqual(yield* ops.readFile("/alias"), text.encode("Data"))
    yield* ops.unlink("/file")
    yield* ops.unlink("/alias")
    assert.deepStrictEqual((yield* handle.pread(4, 0n)).bytes, text.encode("Data"))
    assert.strictEqual((yield* volume.usage).usedBytes, 4n)

    const denied = yield* Effect.flip(
      ops.writeFile("/next", text.encode("x"), { access: "write", create: "exclusive" })
    )

    assert.strictEqual(denied.code, "NoSpace")
    yield* handle.close
    assert.strictEqual((yield* volume.usage).usedBytes, 0n)
    yield* ops.writeFile("/next", text.encode("x"), { access: "write", create: "exclusive" })
    assert.strictEqual((yield* Effect.flip(handle.stat)).code, "InvalidHandle")
  }).pipe(Effect.provide(NodeCrypto.layer)))

it.effect("should enforce independent permissions and lookup rules when private contexts derive roots", () =>
  Effect.gen(function*() {
    const volume = yield* Vfs.make()
    const owner = yield* volume.caller({ umask: 0 })
    yield* owner.mkdir("/work", { mode: 0o777 })

    const user = yield* volume.caller({
      identity: { uid: 1000, gid: 1000, groups: [], privileged: false },
      umask: 0o027
    })

    const rooted = yield* user.withRoot("/work")
    yield* rooted.writeFile("/data", text.encode("private"), {
      access: "write",
      create: "exclusive",
      mode: 0o666
    })
    assert.strictEqual((yield* owner.stat("/work/data")).mode, 0o640)
    yield* owner.symlink("data", "/work/link")
    assert.strictEqual(
      (yield* rooted.stat({ _tag: "Path", path: "/link", followFinalSymlink: false })).kind,
      "symlink"
    )
    yield* owner.chmod("/work/data", 0o000)
    assert.strictEqual((yield* Effect.flip(rooted.readFile("/data"))).code, "AccessDenied")
    assert.strictEqual((yield* Effect.flip(rooted.stat("/../outside"))).code, "NotFound")
  }).pipe(Effect.provide(NodeCrypto.layer)))

it.effect("should preserve a replacement when private cleanup observes a changed entry", () =>
  Effect.gen(function*() {
    const ops = yield* (yield* Vfs.make()).caller({ umask: 0 })
    yield* ops.mkdir("/owned")
    yield* ops.writeFile("/owned/file", text.encode("old"), { access: "write", create: "exclusive" })
    const expected = yield* ops.lookup("/owned")
    let reached = false

    const beforeTreeRemoval = Effect.gen(function*() {
      if (reached) return
      reached = true
      yield* ops.rename("/owned/file", "/moved")
      yield* ops.writeFile("/owned/file", text.encode("replacement"), { access: "write", create: "exclusive" })
    }).pipe(Effect.orDie)

    assert.strictEqual(
      (yield* Effect.flip(
        ops.remove("/owned", { recursive: true, expected }).pipe(withVolumeTestSeams({ beforeTreeRemoval }))
      )).code,
      "NotFound"
    )
    assert.isTrue(reached)
    assert.deepStrictEqual(yield* ops.readFile("/owned/file"), text.encode("replacement"))
    assert.deepStrictEqual(yield* ops.readFile("/moved"), text.encode("old"))
  }).pipe(Effect.provide(NodeCrypto.layer)))

describe("persistent inode ownership", () => {
  const { emptyState, getNode, setNode } = State

  describe("inode state ownership", () => {
    it("should preserve earlier state when an inode is replaced and removed", () => {
      const first = emptyState(0n)
      const node = file(2)
      const second = { ...first, inodes: setNode(first.inodes, node) }
      const third = { ...second, inodes: HashMap.remove(second.inodes, node.ino) }
      assert.isUndefined(getNode(first, node.ino))
      assert.strictEqual(getNode(second, node.ino), node)
      assert.isUndefined(getNode(third, node.ino))
    })

    it("should replace metadata without inspecting payloads when a private inode is stored", () => {
      const first = emptyState(0n)
      const original = file(2)
      const updated = { ...file(2), metadata: { ...original.metadata, mode: 0o600 } }

      for (const node of [original, updated]) {
        Object.defineProperty(node, "data", {
          get: () => {
            throw new Error("Metadata replacement must not inspect payloads")
          },
          enumerable: true
        })
      }

      const second = { ...first, inodes: setNode(first.inodes, original) }
      const third = { ...second, inodes: setNode(second.inodes, updated) }
      assert.strictEqual(getNode(second, original.ino)?.metadata.mode, 0o644)
      assert.strictEqual(getNode(third, updated.ino)?.metadata.mode, 0o600)
    })
  })
})

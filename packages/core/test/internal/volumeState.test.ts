import { assert, describe, it } from "@effect/vitest"
import { HashMap } from "effect"
import { emptyState, getNode, setNode } from "../../src/internal/volumeState.js"
import { file } from "../support/volumeState.js"

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

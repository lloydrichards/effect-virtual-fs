import { assert, describe, it } from "@effect/vitest"
import * as InodeTable from "../src/internal/inodeTable.js"

const KEYS = [
  0,
  1,
  31,
  32,
  33,
  1023,
  1024,
  32768,
  2 ** 25,
  2 ** 32 - 1,
  2 ** 32,
  2 ** 32 + 31,
  2 ** 35,
  2 ** 35 + 5,
  2 ** 40 + 7
]

describe("inode table", () => {
  it("keeps every key reachable as the table grows past each level, including beyond 2^35", () => {
    let table = InodeTable.empty<string>()

    for (const key of KEYS) {
      table = InodeTable.set(table, key, `v${key}`)

      for (const earlier of KEYS) {
        if (earlier > key) break
        assert.strictEqual(InodeTable.get(table, earlier), `v${earlier}`, `key ${earlier} after inserting ${key}`)
      }
    }

    assert.isUndefined(InodeTable.get(table, 2))
    assert.isUndefined(InodeTable.get(table, 2 ** 35 + 6))
    assert.isUndefined(InodeTable.get(table, 2 ** 45))
  })

  it("leaves earlier versions untouched and clears a key without disturbing its neighbours", () => {
    const first = InodeTable.set(InodeTable.empty<number>(), 5, 50)
    const second = InodeTable.set(first, 6, 60)
    const third = InodeTable.set(second, 5, undefined)

    assert.strictEqual(InodeTable.get(first, 5), 50)
    assert.isUndefined(InodeTable.get(first, 6))
    assert.strictEqual(InodeTable.get(second, 5), 50)
    assert.strictEqual(InodeTable.get(second, 6), 60)
    assert.isUndefined(InodeTable.get(third, 5))
    assert.strictEqual(InodeTable.get(third, 6), 60)
  })

  it("shares arrays only within one owner's batch of writes", () => {
    const base = InodeTable.set(InodeTable.empty<number>(), 1, 1)
    const owner = Symbol()
    const other = Symbol()
    const a = InodeTable.set(base, 2, 2, owner)
    const b = InodeTable.set(a, 3, 3, owner)
    const c = InodeTable.set(a, 4, 4, other)

    assert.isUndefined(InodeTable.get(base, 2))
    // The second write under the same owner edits the array the first one already copied.
    assert.strictEqual(InodeTable.get(a, 3), 3)
    assert.strictEqual(InodeTable.get(b, 3), 3)
    // A different owner copies again, so its write never shows through the first owner's table.
    assert.isUndefined(InodeTable.get(b, 4))
    assert.strictEqual(InodeTable.get(c, 4), 4)
    assert.strictEqual(InodeTable.get(c, 3), 3)
  })
})

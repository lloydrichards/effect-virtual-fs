import { assert } from "@effect/vitest"
import { Effect } from "effect"
import { VirtualFileSystem as Vfs } from "../../src/index.js"

const bytes = (text: string) => new TextEncoder().encode(text)

export const hardLinkedSymlinks: Vfs.Fixture = {
  entries: [
    ...["a", "b", "c"].flatMap((parent) => [
      { kind: "directory" as const, path: `/${parent}` },
      { kind: "file" as const, path: `/${parent}/target`, bytes: bytes(parent) }
    ]),
    { kind: "symlink", path: "/a/link", target: "target" },
    { kind: "hardLink", path: "/b/link", target: "/a/link" },
    { kind: "hardLink", path: "/c/link", target: "/b/link" },
    { kind: "symlink", path: "/a/dangling", target: "missing" },
    { kind: "hardLink", path: "/b/dangling", target: "/a/dangling" }
  ]
}

export const assertHardLinkedSymlinks = Effect.fnUntraced(function*(caller: Vfs.Caller) {
  const reference = yield* caller.lookup("/a/link")

  for (const parent of ["a", "b", "c"]) {
    const path = `/${parent}/link`
    const metadata = yield* caller.stat(Vfs.Target.Path({ path, followFinalSymlink: false }))
    assert.strictEqual(metadata.kind, "symlink")
    assert.strictEqual(metadata.nlink, 3)
    assert.strictEqual(yield* caller.lookup(path), reference)
    assert.deepStrictEqual(yield* caller.readLink(path), bytes("target"))
    assert.deepStrictEqual(yield* caller.readFile(path), bytes(parent))
  }

  const dangling = yield* caller.lookup("/a/dangling")

  for (const parent of ["a", "b"]) {
    const path = `/${parent}/dangling`
    const metadata = yield* caller.stat(Vfs.Target.Path({ path, followFinalSymlink: false }))
    assert.strictEqual(metadata.kind, "symlink")
    assert.strictEqual(metadata.nlink, 2)
    assert.strictEqual(yield* caller.lookup(path), dangling)
    assert.deepStrictEqual(yield* caller.readLink(path), bytes("missing"))
    assert.strictEqual((yield* Effect.flip(caller.readFile(path))).code, "NotFound")
  }
})

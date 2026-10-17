import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { Effect } from "effect"

const text = new TextEncoder()

export const FOUR_FILES_FIXTURE: Vfs.Fixture = {
  entries: ["a", "b", "c", "d"].map((name) => ({ kind: "file", path: `/${name}`, bytes: new Uint8Array() }))
}

export const representativeTree = Effect.gen(function*() {
  const invalidName = yield* Vfs.pathFromBytes(new Uint8Array([...text.encode("/src/raw-"), 0xff]))

  return yield* Vfs.fromFixture({
    entries: [
      { kind: "directory", path: "/src", metadata: { mode: 0o750, atimeNs: 11n, mtimeNs: 12n, ctimeNs: 13n } },
      { kind: "directory", path: "/src/nested", metadata: { mode: 0o555, mtimeNs: 21n } },
      {
        kind: "file",
        path: "/src/nested/data.bin",
        bytes: new Uint8Array([0, 255, 1, 254]),
        metadata: { mode: 0o4755, atimeNs: 31n, mtimeNs: 32n, birthtimeNs: 33n }
      },
      { kind: "hardLink", path: "/src/alias.bin", target: "/src/nested/data.bin" },
      { kind: "symlink", path: "/src/relative", target: "nested/data.bin" },
      { kind: "symlink", path: "/src/dangling", target: "missing" },
      { kind: "symlink", path: "/src/escaping", target: "/etc/passwd" },
      { kind: "hardLink", path: "/src/relative-alias", target: "/src/relative" },
      { kind: "file", path: invalidName, bytes: text.encode("raw"), metadata: { mode: 0o600, mtimeNs: 41n } }
    ]
  })
})

import type { VirtualFileSystem as Vfs } from "@effect-vfs/core"

export const FOUR_FILES_FIXTURE: Vfs.Fixture = {
  entries: ["a", "b", "c", "d"].map((name) => ({ kind: "file", path: `/${name}`, bytes: new Uint8Array() }))
}

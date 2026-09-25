import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { VirtualFileSystem as Vfs } from "../../src/index.js"
import { pathText } from "./text.js"

/** An unprivileged identity that owns nothing a test did not give it. */
export const GUEST = { uid: 9, gid: 9, groups: [], privileged: false } as const

/** The options of a recursive `mkdir` or `remove`. */
export const RECURSIVE = { recursive: true } as const

/** Creates a file of `size` zero bytes, failing when the name exists. */
export const write = (fs: Vfs.Caller, path: string, size = 1) =>
  fs.writeFile(path, new Uint8Array(size), { access: "write", create: "exclusive" })

/** Whether a path names an entry, without following a final symbolic link. */
export const exists = (fs: Vfs.Caller, path: string) =>
  Effect.map(Effect.result(fs.stat(Vfs.Target.Path({ path, followFinalSymlink: false }))), Result.isSuccess)

/** A failure as its code and the path it names, as text. */
export const failure = (error: Vfs.VfsError) => Effect.map(pathText(error.path), (path) => [error.code, path] as const)

import { Effect, Stream } from "effect"
import * as Hex from "effect/encoding/Hex"
import { BytePath, type VirtualFileSystem as Vfs } from "../../src/index.js"

const bytes = (value: string) => new TextEncoder().encode(value)

export const describeTree = Effect.fnUntraced(function*(caller: Vfs.Caller) {
  const walked = yield* Stream.runCollect(caller.walk("/"))

  const objects: Array<{ path: Uint8Array; reference: Vfs.ObjectReference }> = [
    { path: bytes("/"), reference: yield* caller.root }
  ]

  for (const entry of walked) objects.push({ path: yield* BytePath.toBytes(entry.path), reference: entry.reference })
  const paths = new Map<bigint, Array<string>>()
  const rows: Array<{ key: string; ino: bigint; metadata: object; payload: string | undefined }> = []

  for (const { path, reference } of objects) {
    const { ino, revision: _revision, ...metadata } = yield* caller.stat(reference)
    const key = Hex.encode(path)
    paths.set(ino, [...(paths.get(ino) ?? []), key])

    const payload = metadata.kind === "file"
      ? yield* caller.readFile(reference)
      : metadata.kind === "symlink"
      ? yield* caller.readLink(reference)
      : undefined

    rows.push({ key, ino, metadata, payload: payload === undefined ? undefined : Hex.encode(payload) })
  }

  // Inode numbers are not portable, so each row names the paths that share its object instead.
  return rows
    .map(({ ino, ...row }) => ({ ...row, links: [...(paths.get(ino) ?? [])].sort() }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
})

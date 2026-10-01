import * as Effect from "effect/Effect"
import * as Hex from "effect/encoding/Hex"
import * as InodeTable from "../../src/internal/inodeTable.js"
import {
  type Directory,
  directoryMetadata,
  emptyState,
  getNode,
  Ino,
  type Node,
  type RegularFile,
  ROOT_INO,
  type SymbolicLink
} from "../../src/internal/volumeState.js"

const encoder = new TextEncoder()

export const name = (value: string) => Hex.encode(encoder.encode(value))

export const directory = (ino: number, parent = ROOT_INO, entry = "", mode = 0o755): Directory => ({
  kind: "directory",
  ino: Ino(ino),
  parent,
  name: name(entry),
  entries: new Map(),
  metadata: directoryMetadata(BigInt(ino), 0, 0, mode, 0n),
  revision: 0n
})

export const file = (ino: number, nlink = 1): RegularFile => ({
  kind: "file",
  ino: Ino(ino),
  data: new Uint8Array([1, 2]),
  links: nlink === 0 ? [] : [{ parent: ROOT_INO, name: name("file") }],
  metadata: { ...directoryMetadata(BigInt(ino), 0, 0, 0o644, 0n), kind: "file", size: 2n, nlink },
  revision: 0n
})

export const symlink = (ino: number, target: string): SymbolicLink => ({
  kind: "symlink",
  ino: Ino(ino),
  target: encoder.encode(target),
  links: [{ parent: ROOT_INO, name: name("link") }],
  metadata: {
    ...directoryMetadata(BigInt(ino), 0, 0, 0o777, 0n),
    kind: "symlink",
    size: BigInt(target.length),
    nlink: 1
  },
  revision: 0n
})

export const volumeState = () => {
  let state = emptyState(0n)
  const owner = Symbol()

  const put = (node: Node) => {
    state = { ...state, inodes: InodeTable.set(state.inodes, node.ino, node, owner) }
  }

  return {
    get state() {
      return state
    },
    get: (ino: Ino) => Effect.sync(() => getNode(state, ino)),
    put,
    remove: (ino: Ino) => {
      state = { ...state, inodes: InodeTable.set(state.inodes, ino, undefined, owner) }
    },
    attach: (parent: Directory, entry: string, node: Node) => {
      put(node)
      const current = getNode(state, parent.ino)

      if (current?.kind === "directory") {
        put({ ...current, entries: new Map(current.entries).set(name(entry), node.ino) })
      }
    },
    retain: (ino: Ino) =>
      Effect.sync(() => {
        state = { ...state, open: new Map(state.open).set(ino, (state.open.get(ino) ?? 0) + 1) }
      }),
    release: (ino: Ino) =>
      Effect.sync(() => {
        const open = new Map(state.open)
        const count = (open.get(ino) ?? 0) - 1

        if (count <= 0) open.delete(ino)
        else open.set(ino, count)
        const node = getNode(state, ino)
        state = {
          ...state,
          open,
          inodes: count <= 0 && node?.metadata.nlink === 0
            ? InodeTable.set(state.inodes, ino, undefined, owner)
            : state.inodes
        }
      })
  }
}

// This versioned digest covers namespace content and hard-link groups, independent of inode numbers. Framing,
// byte order, and domain prefix are part of the persisted delta contract.
import * as ByteSize from "effect/ByteSize"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type * as PlatformError from "effect/PlatformError"
import type { ImageFailure } from "../VfsError.js"
import { bytesOrder } from "./bytes.js"
import { imageFailure } from "./errors.js"
import { joinPath, nameBytes, ROOT_PATH } from "./path.js"
import { byEntryName, getNode, type Ino, type Node, payloadOf, ROOT_INO, type VolumeState } from "./volumeState.js"

const ALGORITHM = "effect-vfs-semantic-sha256-v1"
/** @internal */
export const DIGEST_BYTES = 32
const U64_BYTES = 8

const encoder = new TextEncoder()

const IDENTITY_PREFIX = encoder.encode(`${ALGORITHM}\0`)
const KIND_BYTE = { directory: 0, file: 1, symlink: 2 } as const

/** @internal */
export interface WalkBudget {
  readonly operation: string
  readonly records: number
  readonly recordsField: string
  readonly entries: number
  readonly identityBytes: ByteSize.ByteSize
  // Base snapshots use the identity byte bound for payloads too.
  readonly payloadBytes?: { readonly limit: ByteSize.ByteSize; readonly field: string }
}

/** @internal */
export interface Identity {
  readonly digest: Uint8Array
  readonly digests: ReadonlyMap<Ino, Uint8Array>
  readonly groups: ReadonlyMap<Ino, ReadonlyArray<Uint8Array>>
  readonly records: number
  readonly payloadBytes: number
  readonly nodeBytes: number
}

const u64 = (out: Uint8Array, offset: number, n: number) => {
  new DataView(out.buffer, out.byteOffset).setBigUint64(offset, BigInt(n), false)

  return offset + U64_BYTES
}

const frame = (out: Uint8Array, offset: number, bytes: Uint8Array) => {
  const at = u64(out, offset, bytes.length)
  out.set(bytes, at)

  return at + bytes.length
}

const stamps = (node: Node): ReadonlyArray<Uint8Array> =>
  [node.metadata.atimeNs, node.metadata.mtimeNs, node.metadata.ctimeNs, node.metadata.birthtimeNs].map((value) =>
    encoder.encode(String(value))
  )

interface Layout {
  readonly times: ReadonlyArray<Uint8Array>
  readonly entries: ReadonlyArray<readonly [Uint8Array, Ino]>
  readonly body: Uint8Array | undefined
  readonly length: number
}

const layout = (node: Node): Layout => {
  const times = stamps(node)

  const entries = node.kind === "directory"
    ? [...node.entries].sort(byEntryName).map(([name, ino]) => [nameBytes(name), ino] as const)
    : []

  const body = payloadOf(node)

  const length = 1 + 3 * U64_BYTES + times.reduce((sum, stamp) => sum + U64_BYTES + stamp.length, 0) +
    (body === undefined
      ? U64_BYTES + entries.reduce((sum, [name]) => sum + U64_BYTES + name.length + DIGEST_BYTES, 0)
      : U64_BYTES + body.length)

  return { times, entries, body, length }
}

/** @internal */
export const nodeBytes = (node: Node): number => layout(node).length

const preimage = (node: Node, { body, entries, length, times }: Layout, childDigest: (ino: Ino) => Uint8Array) => {
  const out = new Uint8Array(length)
  out[0] = KIND_BYTE[node.kind]
  let offset = u64(out, 1, node.metadata.uid)
  offset = u64(out, offset, node.metadata.gid)
  offset = u64(out, offset, node.metadata.mode)

  for (const stamp of times) offset = frame(out, offset, stamp)

  if (body !== undefined) frame(out, offset, body)
  else {
    offset = u64(out, offset, entries.length)

    for (const [name, ino] of entries) {
      offset = frame(out, offset, name)
      out.set(childDigest(ino), offset)
      offset += DIGEST_BYTES
    }
  }

  return out
}

/** @internal */
export interface Meter {
  readonly charge: (bytes: number) => Effect.Effect<void, ImageFailure>
  readonly spent: () => number
}

/** @internal */
export const meter = (budget: WalkBudget): Meter => {
  let hashed = 0

  return {
    charge: (bytes) =>
      Effect.suspend(() => {
        hashed += bytes

        return ByteSize.isGreaterThan(ByteSize.bytes(hashed), budget.identityBytes)
          ? Effect.fail(imageFailure(budget.operation, "LimitExceeded", { field: "identityBytes" }))
          : Effect.void
      }),
    spent: () => hashed
  }
}

/** @internal */
export const nodeDigest = Effect.fnUntraced(function*(node: Node, childDigest: (ino: Ino) => Uint8Array, meter: Meter) {
  const crypto = yield* Crypto.Crypto
  const planned = layout(node)
  // Reject oversized nodes before allocating their preimage.
  yield* meter.charge(planned.length)

  return yield* crypto.digest("SHA-256", preimage(node, planned, childDigest))
})

/** @internal */
export const identityDigest = Effect.fnUntraced(
  function*(root: Uint8Array, groups: Iterable<ReadonlyArray<Uint8Array>>, meter: Meter) {
    const crypto = yield* Crypto.Crypto
    const sorted = [...groups].sort((a, b) => bytesOrder(a[0]!, b[0]!))

    const length = IDENTITY_PREFIX.length + DIGEST_BYTES + U64_BYTES +
      sorted.reduce((sum, group) => group.reduce((inner, path) => inner + U64_BYTES + path.length, sum + U64_BYTES), 0)

    yield* meter.charge(length)
    const out = new Uint8Array(length)
    out.set(IDENTITY_PREFIX)
    out.set(root, IDENTITY_PREFIX.length)
    let offset = u64(out, IDENTITY_PREFIX.length + DIGEST_BYTES, sorted.length)

    for (const group of sorted) {
      offset = u64(out, offset, group.length)

      for (const path of group) offset = frame(out, offset, path)
    }

    return yield* crypto.digest("SHA-256", out)
  }
)

// Digest leaves first and directories in reverse walk order so every child digest exists before its parent.
/** @internal */
export const identify = Effect.fnUntraced(
  function*(
    state: VolumeState,
    budget: WalkBudget
  ): Effect.fn.Return<Identity, ImageFailure | PlatformError.PlatformError, Crypto.Crypto> {
    const root = getNode(state, ROOT_INO)

    if (root?.kind !== "directory") {
      return yield* imageFailure(budget.operation, "InvalidStructure", { field: "root" })
    }

    const order: Array<Node> = [root]

    // The root is a record too, so a limit of zero refuses even an empty snapshot.
    if (order.length > budget.records) {
      return yield* imageFailure(budget.operation, "LimitExceeded", { field: budget.recordsField })
    }

    const seen = new Set<Ino>([ROOT_INO])
    const directoryPaths = new Map<Ino, Uint8Array>([[ROOT_INO, ROOT_PATH]])
    const named = new Map<Ino, Array<Uint8Array>>()
    let entries = 0

    for (let index = 0; index < order.length; index++) {
      const node = order[index]!

      if (node.kind !== "directory") continue
      const path = directoryPaths.get(node.ino)!

      for (const [name, ino] of node.entries) {
        if (++entries > budget.entries) {
          return yield* imageFailure(budget.operation, "LimitExceeded", { field: "entries" })
        }

        const child = getNode(state, ino)

        if (child === undefined) continue

        if (child.kind === "directory") directoryPaths.set(ino, joinPath(path, nameBytes(name)))
        else if (child.links.length > 1) {
          const paths = named.get(ino)
          const childPath = joinPath(path, nameBytes(name))

          if (paths === undefined) named.set(ino, [childPath])
          else paths.push(childPath)
        }

        if (seen.has(ino)) continue
        seen.add(ino)
        order.push(child)

        if (order.length > budget.records) {
          return yield* imageFailure(budget.operation, "LimitExceeded", { field: budget.recordsField })
        }
      }
    }

    const digests = new Map<Ino, Uint8Array>()
    const measure = meter(budget)
    const lookup = (ino: Ino) => digests.get(ino)!
    let payloadBytes = 0

    const leavesFirst = [
      ...order.filter((node) => node.kind !== "directory"),
      ...order.filter((node) => node.kind === "directory").reverse()
    ]

    for (const node of leavesFirst) {
      const body = payloadOf(node)

      if (body !== undefined) {
        payloadBytes += body.length

        if (
          budget.payloadBytes !== undefined &&
          ByteSize.isGreaterThan(ByteSize.bytes(payloadBytes), budget.payloadBytes.limit)
        ) {
          return yield* imageFailure(budget.operation, "LimitExceeded", { field: budget.payloadBytes.field })
        }
      }

      digests.set(node.ino, yield* nodeDigest(node, lookup, measure))
    }

    const groups = new Map<Ino, ReadonlyArray<Uint8Array>>()

    for (const [ino, paths] of named) if (paths.length > 1) groups.set(ino, paths.sort(bytesOrder))

    const nodeBytes = measure.spent()

    return {
      digest: yield* identityDigest(digests.get(ROOT_INO)!, groups.values(), measure),
      digests,
      groups,
      records: order.length,
      payloadBytes,
      nodeBytes
    }
  }
)

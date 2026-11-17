import { onHandleRelease } from "@effect-vfs/effect-preview/internal/durableStorage"
import type { Effect } from "effect"
import { ObjectReferenceId } from "../Caller.js"
import type * as V from "../VirtualFileSystem.js"

type PreviewHandle = Parameters<typeof onHandleRelease>[0]

type Observation = Effect.Success<ReturnType<PreviewHandle["stat"]>>

type ObjectRevision = Observation["revision"]

export interface Token {
  readonly reference: Observation["reference"]
  revision: ObjectRevision | undefined
  number: bigint
  readonly core: V.ObjectReference
  readonly ino: bigint
}

export const issuedReferences = new WeakSet<V.ObjectReference>()

export const make = <Grant>(
  hasName: (ino: bigint) => boolean,
  equalsRevision: (left: ObjectRevision, right: ObjectRevision) => boolean
) => {
  const tokens = new Map<bigint, Token>()
  const references = new WeakMap<V.ObjectReference, Token>()
  const orders = new Map<bigint, Array<string>>()
  const links = new Map<bigint, Uint8Array>()
  const retained = new Map<bigint, Set<PreviewHandle>>()
  const activeGrants = new Set<Grant>()

  const intern = (
    reference: Observation["reference"],
    ino: bigint,
    revision: ObjectRevision | undefined,
    stamp: bigint
  ) => {
    const known = tokens.get(ino)

    if (known !== undefined) {
      if (revision !== undefined) {
        if (known.revision !== undefined && !equalsRevision(known.revision, revision)) {
          known.number = stamp > known.number ? stamp : known.number + 1n
        }

        known.revision = revision
      }

      return known
    }

    const core: V.ObjectReference = Object.freeze({ [ObjectReferenceId]: true as const })
    const created: Token = { core, ino, reference, revision, number: stamp }

    tokens.set(ino, created)
    references.set(core, created)
    issuedReferences.add(core)

    return created
  }

  // Namespace changes publish only after storage accepts them. Check all aliases
  // after the whole batch so the remove/create pair of a rename preserves identity.
  const retire = (ino: bigint) => {
    if (hasName(ino)) return
    orders.delete(ino)
    links.delete(ino)

    if (!retained.has(ino)) tokens.delete(ino)
  }

  const track = (handle: PreviewHandle, grant?: Grant) => {
    const ino = onHandleRelease(handle, (released) => {
      const handles = retained.get(released)

      handles?.delete(handle)

      if (handles?.size === 0) {
        retained.delete(released)
        retire(released)
      }

      if (grant !== undefined) activeGrants.delete(grant)
    })

    if (ino === undefined) return
    const handles = retained.get(ino)

    if (handles === undefined) retained.set(ino, new Set([handle]))
    else handles.add(handle)

    if (grant !== undefined) activeGrants.add(grant)
  }

  return { intern, tokens, references, links, orders, retained, activeGrants, retire, track }
}

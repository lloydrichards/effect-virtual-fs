/**
 * Immutable regular-file payloads shared by overlay workspaces.
 *
 * @internal
 */
import type { Snapshot } from "../Snapshot.js"
import * as Image from "./image.js"

/** @internal */
export interface Content {
  readonly bytes: Uint8Array
}

const overlayContents = new WeakMap<Snapshot, ReadonlyMap<string, Content>>()

/** @internal */
export const hasOverlayContents = (snapshot: Snapshot): boolean => overlayContents.has(snapshot)

/** @internal */
export const make = (bytes: Uint8Array): Content => ({ bytes })

/** @internal */
export const empty = (): Content => make(new Uint8Array(0))

/**
 * Returns the immutable file payloads associated with the identity of a base
 * snapshot. The cache is weak so it cannot extend the snapshot's lifetime.
 *
 * @internal
 */
export const forOverlay = (snapshot: Snapshot, image: Image.Document): ReadonlyMap<string, Content> => {
  const cached = overlayContents.get(snapshot)
  if (cached !== undefined) return cached
  const decoded = new Map<string, Content>()
  for (const record of image.records) {
    if (record.kind === "file") decoded.set(record.id, make(Image.bytes(record.data)))
  }
  overlayContents.set(snapshot, decoded)
  return decoded
}

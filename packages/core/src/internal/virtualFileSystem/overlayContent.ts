// Immutable regular-file payloads shared by overlay workspaces.
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type { Snapshot } from "../../Snapshot.js"
import { CanonicalBase64 } from "../canonicalBase64.js"
import * as Image from "../image.js"

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

// The weak cache shares immutable payloads without extending the snapshot's lifetime.
/** @internal */
export const forOverlay = (snapshot: Snapshot, image: Image.Document): ReadonlyMap<string, Content> => {
  const cached = overlayContents.get(snapshot)

  if (cached !== undefined) return cached
  const decoded = new Map<string, Content>()

  for (const record of image.records) {
    if (Image.Record.guards.file(record)) {
      const bytes = Schema.decodeResult(CanonicalBase64.Bytes)(record.data)

      if (Result.isSuccess(bytes)) decoded.set(record.id, make(bytes.success))
    }
  }

  overlayContents.set(snapshot, decoded)

  return decoded
}

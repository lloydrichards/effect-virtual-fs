// Immutable regular-file payloads. A payload is never changed in place: every write replaces it, so volumes
// restored from one snapshot share unchanged payloads safely.

/** @internal */
export interface Content {
  readonly bytes: Uint8Array
}

/** @internal */
export const make = (bytes: Uint8Array): Content => ({ bytes })

/** @internal */
export const empty = (): Content => make(new Uint8Array(0))

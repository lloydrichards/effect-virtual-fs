import * as ByteSize from "effect/ByteSize"
import * as Result from "effect/Result"
import type { VolumeLimits } from "../VirtualFileSystem.js"
import { type VolumeIdentity, VolumeOptions } from "../Volume.js"
import { decodeConfiguration } from "./errors.js"
import type * as Tree from "./tree.js"
import { MAX_FILE_BYTES } from "./volumeState.js"

type StoredLimits = Tree.Runtime["limits"]

type MutableOptions = { -readonly [K in keyof VolumeOptions]: VolumeOptions[K] }

type MutableStoredLimits = { -readonly [K in keyof StoredLimits]: StoredLimits[K] }

/** @internal */
export const defaults: VolumeLimits = Object.freeze({
  maxEntries: undefined,
  maxBytes: undefined,
  maxFileBytes: ByteSize.bytes(MAX_FILE_BYTES),
  maxPathBytes: undefined,
  maxPendingOperations: 64,
  maxWatchEvents: 256
})

/** @internal */
export const configuration = (options?: VolumeOptions, operation = "make") =>
  Result.map(
    decodeConfiguration(VolumeOptions, options === undefined ? {} : options, operation),
    (decoded) => ({
      options: decoded,
      identity: decoded.identity,
      limits: Object.freeze({
        maxEntries: decoded.maxEntries,
        maxBytes: decoded.maxBytes,
        maxFileBytes: decoded.maxFileBytes ?? defaults.maxFileBytes,
        maxPathBytes: decoded.maxPathBytes,
        maxPendingOperations: decoded.maxPendingOperations ?? defaults.maxPendingOperations,
        maxWatchEvents: decoded.maxWatchEvents ?? defaults.maxWatchEvents
      }) satisfies VolumeLimits
    })
  )

/** @internal */
export const fromOptions = (options?: VolumeOptions, operation = "make") =>
  Result.map(configuration(options, operation), (decoded) => decoded.limits)

/** @internal */
export const fromStored = (stored: StoredLimits, runtime: VolumeLimits = defaults) => {
  const options: MutableOptions = {
    maxPendingOperations: runtime.maxPendingOperations,
    maxWatchEvents: runtime.maxWatchEvents
  }

  if (stored.maxEntries !== undefined) options.maxEntries = stored.maxEntries

  if (stored.maxBytes !== undefined) options.maxBytes = ByteSize.bytes(stored.maxBytes)

  if (stored.maxFileBytes !== undefined) options.maxFileBytes = ByteSize.bytes(stored.maxFileBytes)

  if (stored.maxPathBytes !== undefined) options.maxPathBytes = ByteSize.bytes(stored.maxPathBytes)

  return fromOptions(options)
}

/** @internal */
export const toStored = (limits: VolumeLimits): StoredLimits => {
  const stored: MutableStoredLimits = {
    maxFileBytes: ByteSize.toBigInt(limits.maxFileBytes)
  }

  if (limits.maxEntries !== undefined) stored.maxEntries = limits.maxEntries

  if (limits.maxBytes !== undefined) stored.maxBytes = ByteSize.toBigInt(limits.maxBytes)

  if (limits.maxPathBytes !== undefined) stored.maxPathBytes = ByteSize.toBigInt(limits.maxPathBytes)

  return stored
}

const sameSize = (left: ByteSize.ByteSize | undefined, right: ByteSize.ByteSize | undefined) =>
  left === undefined || right === undefined ? left === right : ByteSize.toBigInt(left) === ByteSize.toBigInt(right)

/** @internal */
export const compatible = (
  stored: VolumeLimits,
  requested: VolumeLimits,
  identity: VolumeIdentity,
  requestedIdentity?: VolumeIdentity
): boolean =>
  stored.maxEntries === requested.maxEntries && sameSize(stored.maxBytes, requested.maxBytes) &&
  sameSize(stored.maxFileBytes, requested.maxFileBytes) && sameSize(stored.maxPathBytes, requested.maxPathBytes) &&
  (requestedIdentity === undefined || requestedIdentity === identity)

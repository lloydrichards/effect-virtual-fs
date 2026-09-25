// Package-internal synchronization seams for deterministic volume tests.

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"

/** @internal */
export interface VolumeTestSeams {
  readonly afterSubscribe: Effect.Effect<void>
  readonly betweenSnapshotAndSummary: Effect.Effect<void>
  // Runs before a recursive remove removes each entry below its target, outside the volume's gate.
  readonly beforeTreeRemoval: Effect.Effect<void>
}

/**
 * Read in the caller's fiber, so a test supplies it with `withVolumeTestSeams` on the call under test.
 *
 * @internal
 */
export const VolumeTestSeams: Context.Reference<VolumeTestSeams> = Context.Reference<VolumeTestSeams>(
  "@effect-vfs/core/VolumeTestSeams",
  {
    defaultValue: () => ({
      afterSubscribe: Effect.void,
      betweenSnapshotAndSummary: Effect.void,
      beforeTreeRemoval: Effect.void
    })
  }
)

/** @internal */
export const withVolumeTestSeams = (seams: Partial<VolumeTestSeams>) =>
  Effect.updateService(VolumeTestSeams, (current) => ({
    afterSubscribe: seams.afterSubscribe ?? current.afterSubscribe,
    betweenSnapshotAndSummary: seams.betweenSnapshotAndSummary ?? current.betweenSnapshotAndSummary,
    beforeTreeRemoval: seams.beforeTreeRemoval ?? current.beforeTreeRemoval
  }))

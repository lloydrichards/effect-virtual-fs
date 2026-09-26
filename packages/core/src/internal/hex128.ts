import * as Schema from "effect/Schema"

/** @internal */
export const Hex128 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/))

/** @internal */
export const VolumeEpoch = Hex128.pipe(Schema.brand("@effect-vfs/core/VolumeEpoch"))

/** @internal */
export type VolumeEpoch = typeof VolumeEpoch.Type

/** @internal */
export const KeySecret = Hex128.pipe(Schema.brand("@effect-vfs/core/KeySecret"))

/** @internal */
export type KeySecret = typeof KeySecret.Type

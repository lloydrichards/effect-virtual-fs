// 128 bits as lowercase hexadecimal, the spelling of a volume's identity, its incarnation, its reference-key epoch
// and the secret behind its reference-key tags.
import * as Schema from "effect/Schema"

/** @internal */
export const Hex128 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/))

// The epoch and the key secret share a spelling with the identity; their brands keep one from passing for another.
/** @internal */
export const VolumeEpoch = Hex128.pipe(Schema.brand("@effect-vfs/core/VolumeEpoch"))

/** @internal */
export type VolumeEpoch = typeof VolumeEpoch.Type

/** @internal */
export const KeySecret = Hex128.pipe(Schema.brand("@effect-vfs/core/KeySecret"))

/** @internal */
export type KeySecret = typeof KeySecret.Type

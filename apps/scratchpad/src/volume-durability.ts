/**
 * Compile-only public API sketches for issue #97.
 *
 * This file compares candidate shapes before the core contract is changed.
 */
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { Schema } from "effect"
import type { Crypto, Effect, Order, PlatformError } from "effect"

/**
 * Option A: one ordered scalar vocabulary.
 *
 * The array order is weakest to strongest. Consumers can compare the literal
 * value directly or use `members` / `pick` when deriving a narrower schema.
 */
export namespace LiteralDurability {
  export const Durability = Schema.Literals([
    "memory-only",
    "survives-process-crash",
    "survives-operating-system-crash",
    "survives-power-loss"
  ])

  export type Durability = typeof Durability.Type

  export interface VolumeFacts {
    readonly durability: Durability
  }
}

/** Selected public representation. The exact initial vocabulary is still under review. */
export const Durability = LiteralDurability.Durability

export type Durability = typeof Durability.Type

/** Option A for making the selected weakest-to-strongest ordering public. */
export declare const DurabilityOrder: Order.Order<Durability>

export const isAtLeast = (actual: Durability, required: Durability): boolean => DurabilityOrder(actual, required) >= 0

/** Conventional but less literal storage terminology. */
export const ConventionalDurability = Schema.Literals([
  "volatile",
  "process-durable",
  "system-durable",
  "persistent"
])

/**
 * Option B: a tagged union with one case per durability boundary.
 *
 * This provides generated guards and `match`, but every case is currently
 * payload-free, so the tag object carries no information beyond the tag.
 */
export namespace TaggedDurability {
  export const Durability = Schema.TaggedUnion({
    MemoryOnly: {},
    ProcessCrash: {},
    OperatingSystemCrash: {},
    PowerLoss: {}
  })

  export type Durability = typeof Durability.Type

  export interface VolumeFacts {
    readonly durability: Durability
  }
}

/**
 * Option C: individual survival claims.
 *
 * This is naturally extensible, but invalid combinations become representable
 * unless construction enforces the ordering between the fields.
 */
export namespace CapabilityDurability {
  export const Durability = Schema.Struct({
    survivesProcessCrash: Schema.Boolean,
    survivesOperatingSystemCrash: Schema.Boolean,
    survivesPowerLoss: Schema.Boolean
  })

  export type Durability = typeof Durability.Type

  export interface VolumeFacts {
    readonly durability: Durability
  }
}

/**
 * Option D: an open branded string with supported constants.
 *
 * Existing consumers accept future names without a type change, but the schema
 * can no longer reject misspelled or unsupported durability claims.
 */
export namespace OpenDurability {
  export const Durability = Schema.String.pipe(Schema.brand("VolumeDurability"))

  export type Durability = typeof Durability.Type

  export const memoryOnly = Durability.make("memory-only")

  export interface VolumeFacts {
    readonly durability: Durability
  }
}

declare const literalFacts: LiteralDurability.VolumeFacts

declare const taggedFacts: TaggedDurability.VolumeFacts

declare const capabilityFacts: CapabilityDurability.VolumeFacts

declare const openFacts: OpenDurability.VolumeFacts

/** The three sketches as they would be read by an adapter. */
export const examples = {
  literal: literalFacts.durability === "memory-only",
  tagged: TaggedDurability.Durability.guards.MemoryOnly(taggedFacts.durability),
  capability: capabilityFacts.durability.survivesProcessCrash,
  open: openFacts.durability === OpenDurability.memoryOnly
}

declare const StableVolumeIdentityTypeId: unique symbol

declare const VolumeIncarnationTypeId: unique symbol

/** Representation is deliberately deferred until the identity model is selected. */
export interface StableVolumeIdentity {
  readonly [StableVolumeIdentityTypeId]: true
}

/** Representation is deliberately deferred until the identity model is selected. */
export interface VolumeIncarnation {
  readonly [VolumeIncarnationTypeId]: true
}

/** Option A: two facts with different lifecycle meanings. */
export interface SeparateVolumeIdentityFacts {
  readonly identity: StableVolumeIdentity
  readonly incarnation: VolumeIncarnation
}

/** Option B: one epoch value used for every adapter identity. */
export interface IncarnationOnlyVolumeFacts {
  readonly incarnation: VolumeIncarnation
}

/** Option C: the same two facts nested into one public value. */
export interface NestedVolumeIdentityFacts {
  readonly identity: {
    readonly stable: StableVolumeIdentity
    readonly incarnation: VolumeIncarnation
  }
}

/**
 * Proposed construction rule: callers may preserve a logical identity without
 * making it part of snapshot version 1. Omission mints a new identity.
 */
export interface VolumeIdentityOptions {
  readonly identity?: StableVolumeIdentity
}

declare const snapshot: Vfs.Snapshot

declare const makeVolume: (
  options?: VolumeIdentityOptions
) => SeparateVolumeIdentityFacts

declare const restoreVolume: (
  snapshot: Vfs.Snapshot,
  options?: VolumeIdentityOptions
) => SeparateVolumeIdentityFacts

const original = makeVolume()

/** Default restore: a new logical volume and a new incarnation. */
export const independentRestore = restoreVolume(snapshot)

/** Explicit continuation: the same logical identity, but always a new incarnation. */
export const continuedRestore = restoreVolume(snapshot, { identity: original.identity })

/** Option A: immutable, exactly 128-bit, lowercase hexadecimal public values. */
export namespace HexVolumeTokens {
  const Hex128 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/))

  export const StableVolumeIdentity = Hex128.pipe(Schema.brand("StableVolumeIdentity"))
  export type StableVolumeIdentity = typeof StableVolumeIdentity.Type

  export const VolumeIncarnation = Hex128.pipe(Schema.brand("VolumeIncarnation"))
  export type VolumeIncarnation = typeof VolumeIncarnation.Type
}

/** Option B: byte-oriented values must copy at every public boundary. */
export namespace ByteVolumeTokens {
  export interface StableVolumeIdentity {
    readonly bytes: () => Uint8Array
  }

  export interface VolumeIncarnation {
    readonly bytes: () => Uint8Array
  }
}

/** Option C: familiar immutable strings, but with UUID-specific formatting bits. */
export namespace UuidVolumeTokens {
  const Uuid = Schema.String.check(
    Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  )

  export const StableVolumeIdentity = Uuid.pipe(Schema.brand("StableVolumeIdentity"))
  export type StableVolumeIdentity = typeof StableVolumeIdentity.Type

  export const VolumeIncarnation = Uuid.pipe(Schema.brand("VolumeIncarnation"))
  export type VolumeIncarnation = typeof VolumeIncarnation.Type
}

/** Option A: Effect makes the platform cryptography dependency explicit. */
export declare const makeWithCrypto: (options?: VolumeIdentityOptions) => Effect.Effect<
  SeparateVolumeIdentityFacts,
  PlatformError.PlatformError,
  Crypto.Crypto
>

/** Option B: construction keeps its current type but assumes Web Crypto exists. */
export declare const makeWithGlobalCrypto: (
  options?: VolumeIdentityOptions
) => Effect.Effect<SeparateVolumeIdentityFacts>

/** Option C: a VFS-specific service narrows the dependency but still requires a Layer. */
export interface VolumeTokenSource {
  readonly nextIdentity: Effect.Effect<HexVolumeTokens.StableVolumeIdentity>
  readonly nextIncarnation: Effect.Effect<HexVolumeTokens.VolumeIncarnation>
}

export declare const makeWithTokenSource: (options?: VolumeIdentityOptions) => Effect.Effect<
  SeparateVolumeIdentityFacts,
  never,
  VolumeTokenSource
>

/** Selected dependency model; the final error contract is still under review. */
export declare const makeVolumeWithSelectedEntropy: (options?: VolumeIdentityOptions) => Effect.Effect<
  SeparateVolumeIdentityFacts,
  PlatformError.PlatformError,
  Crypto.Crypto
>

/** Option A: construction-time facts are immutable plain fields. */
export interface PlainVolumeFacts {
  readonly durability: Durability
  readonly identity: HexVolumeTokens.StableVolumeIdentity
  readonly incarnation: HexVolumeTokens.VolumeIncarnation
}

/** Option B: the same static facts are exposed as infallible Effects. */
export interface EffectVolumeFacts {
  readonly durability: Effect.Effect<Durability>
  readonly identity: Effect.Effect<HexVolumeTokens.StableVolumeIdentity>
  readonly incarnation: Effect.Effect<HexVolumeTokens.VolumeIncarnation>
}

/** Selected core-facing public shape. */
export interface VolumeFacts {
  readonly durability: Durability
  readonly identity: HexVolumeTokens.StableVolumeIdentity
  readonly incarnation: HexVolumeTokens.VolumeIncarnation
}

/**
 * Proposed NFS separation: storage-derived values follow the volume while
 * session and state identifiers retain an NFS-server lifetime.
 */
export interface NfsIdentitySources {
  /** Derived from `Volume.identity`. */
  readonly fsid: readonly [bigint, bigint]
  /** Derived from `Volume.incarnation`. */
  readonly filehandleGeneration: Uint8Array
  /** Derived from `Volume.incarnation`. */
  readonly writeVerifier: Uint8Array
  /** Derived from `Volume.incarnation` and the directory revision. */
  readonly cookieVerifier: (revision: bigint) => Uint8Array
  /** Minted for the NFS server instance, not the volume. */
  readonly serverGeneration: Uint8Array
}

/** Candidate lifecycle contract for the selected two-generation model. */
export const lifecycle = {
  ordinaryMutation: {
    identityChanges: false,
    incarnationChanges: false,
    serverGenerationChanges: false
  },
  nfsListenerRestartOverSameVolume: {
    identityChanges: false,
    incarnationChanges: false,
    serverGenerationChanges: true
  },
  independentSnapshotRestore: {
    identityChanges: true,
    incarnationChanges: true,
    serverGenerationChanges: true
  },
  continuedSnapshotRestore: {
    identityChanges: false,
    incarnationChanges: true,
    serverGenerationChanges: true
  }
} as const

/** Consolidated public core proposal after the design decisions. */
export namespace ProposedPublicApi {
  export const VolumeDurability = Durability
  export type VolumeDurability = typeof VolumeDurability.Type

  export const VolumeDurabilityOrder = DurabilityOrder

  export const isVolumeDurabilityAtLeast = (
    actual: VolumeDurability,
    required: VolumeDurability
  ): boolean => VolumeDurabilityOrder(actual, required) >= 0

  export const VolumeIdentity = HexVolumeTokens.StableVolumeIdentity
  export type VolumeIdentity = typeof VolumeIdentity.Type

  export const VolumeIncarnation = HexVolumeTokens.VolumeIncarnation
  export type VolumeIncarnation = typeof VolumeIncarnation.Type

  export const VolumeOptions = Schema.Struct({
    ...Vfs.VolumeOptions.fields,
    identity: Schema.optionalKey(VolumeIdentity)
  })

  export type VolumeOptions = typeof VolumeOptions.Type

  export interface Volume extends Omit<Vfs.Volume, "durability" | "identity" | "incarnation"> {
    readonly durability: VolumeDurability
    readonly identity: VolumeIdentity
    readonly incarnation: VolumeIncarnation
  }

  export declare const make: (
    options?: VolumeOptions
  ) => Effect.Effect<Volume, Vfs.ConfigurationError | PlatformError.PlatformError, Crypto.Crypto>

  export declare const fromSnapshot: (
    snapshot: Vfs.Snapshot,
    options?: VolumeOptions
  ) => Effect.Effect<
    Volume,
    Vfs.ConfigurationError | Vfs.ImageError | PlatformError.PlatformError,
    Crypto.Crypto
  >
}

// Executable model prototypes for interface review, not a filesystem implementation.
import * as Data from "effect/Data"
import * as Schema from "effect/Schema"
import type { PathInput } from "./proposed.js"

const Natural = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)
const NonNegativeBigInt = Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n))
const Mode = Natural.check(Schema.isLessThanOrEqualTo(0o7777))

export const FsCode = Schema.Literals([
  "NotFound",
  "AlreadyExists",
  "NotDirectory",
  "IsDirectory",
  "DirectoryNotEmpty",
  "LinkLoop",
  "AccessDenied",
  "OperationNotPermitted",
  "InvalidHandle",
  "ForeignHandle",
  "ClosedCaller",
  "InvalidArgument",
  "InvalidPathEncoding",
  "UnrepresentableName",
  "NoSpace",
  "FileTooLarge",
  "Overflow",
  "NoSeekRegion"
])
export type FsCode = typeof FsCode.Type

export class FsError extends Data.TaggedError("FsError")<{
  readonly code: FsCode
  readonly operation: string
  readonly path?: PathInput
  readonly destination?: PathInput
}> {}

export class ConfigurationError extends Data.TaggedError("ConfigurationError")<{
  readonly field: string
}> {}

export const ImageErrorCode = Schema.Literals([
  "InvalidEncoding",
  "UnsupportedVersion",
  "InvalidStructure",
  "LimitExceeded"
])
export class ImageError extends Data.TaggedError("ImageError")<{
  readonly code: typeof ImageErrorCode.Type
}> {}

export const Identity = Schema.Struct({
  uid: Natural,
  gid: Natural,
  groups: Schema.Array(Natural),
  privileged: Schema.Boolean
})
export type Identity = typeof Identity.Type

export const RootCallerOptions = Schema.Struct({
  identity: Schema.optionalKey(Identity),
  umask: Schema.optionalKey(Natural.check(Schema.isLessThanOrEqualTo(0o777)))
})
export type RootCallerOptions = typeof RootCallerOptions.Type

export const VolumeOptions = Schema.Struct({
  maxStoredBytes: Schema.optionalKey(NonNegativeBigInt),
  maxEntries: Schema.optionalKey(Natural),
  maxFileBytes: Schema.optionalKey(NonNegativeBigInt),
  maxTransferBytes: Schema.optionalKey(Natural)
})
export type VolumeOptions = typeof VolumeOptions.Type

export const Metadata = Schema.Struct({
  kind: Schema.Literals(["file", "directory", "symlink"]),
  ino: NonNegativeBigInt,
  nlink: Natural,
  size: NonNegativeBigInt,
  uid: Natural,
  gid: Natural,
  mode: Mode,
  atimeNs: Schema.BigInt,
  mtimeNs: Schema.BigInt,
  ctimeNs: Schema.BigInt,
  birthtimeNs: Schema.BigInt
})
export type Metadata = typeof Metadata.Type

export const TimeUpdate = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("now") }),
  Schema.Struct({ kind: Schema.Literal("omit") }),
  Schema.Struct({ kind: Schema.Literal("value"), nanoseconds: Schema.BigInt })
])
export type TimeUpdate = typeof TimeUpdate.Type
export const Times = Schema.Struct({ access: TimeUpdate, modification: TimeUpdate })
export type Times = typeof Times.Type

export const OwnerUpdate = Schema.Struct({
  uid: Schema.optionalKey(Identity.fields.uid),
  gid: Schema.optionalKey(Identity.fields.gid)
})
export type OwnerUpdate = typeof OwnerUpdate.Type
export const SeekMode = Schema.Literals(["start", "current", "end", "data", "hole"])
export type SeekMode = typeof SeekMode.Type

export const FixtureMetadata = Schema.Struct({
  uid: Schema.optionalKey(Metadata.fields.uid),
  gid: Schema.optionalKey(Metadata.fields.gid),
  mode: Schema.optionalKey(Metadata.fields.mode),
  atimeNs: Schema.optionalKey(Metadata.fields.atimeNs),
  mtimeNs: Schema.optionalKey(Metadata.fields.mtimeNs),
  ctimeNs: Schema.optionalKey(Metadata.fields.ctimeNs),
  birthtimeNs: Schema.optionalKey(Metadata.fields.birthtimeNs)
})
export type FixtureMetadata = typeof FixtureMetadata.Type

// An opaque path needs its real constructor/guard. Accept that schema rather
// than inventing a permissive runtime guard for a declaration-only BytePath.
export const makeFixtureSchema = <P extends Schema.Top>(path: P) => {
  const common = { path, metadata: Schema.optionalKey(FixtureMetadata) }
  return Schema.Struct({
    entries: Schema.Array(Schema.Union([
      Schema.Struct({ ...common, kind: Schema.Literal("directory") }),
      Schema.Struct({ ...common, kind: Schema.Literal("file"), bytes: Schema.Uint8Array }),
      Schema.Struct({ ...common, kind: Schema.Literal("symlink"), target: path }),
      Schema.Struct({ ...common, kind: Schema.Literal("hardLink"), target: path })
    ])),
    rootMetadata: Schema.optionalKey(FixtureMetadata)
  })
}
export type Fixture<P> = ReturnType<typeof makeFixtureSchema<Schema.Schema<P>>>["Type"]
export type FixtureEntry<P> = Fixture<P>["entries"][number]
export const StringFixture = makeFixtureSchema(Schema.String)

export const DecodeLimits = Schema.Struct({
  maxEncodedBytes: Natural,
  maxRecords: Natural,
  maxEntries: Natural,
  maxDecodedBytes: NonNegativeBigInt
})
export type DecodeLimits = typeof DecodeLimits.Type

// Padding leaves four or two unused bits, respectively; restrict those sextets
// before the codec allocates bytes. The final assertion rejects trailing newlines too.
const SnapshotBytes = Schema.String.check(Schema.isPattern(
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?(?![\s\S])/
)).pipe(Schema.decodeTo(Schema.Uint8ArrayFromBase64))
const SnapshotInteger = Schema.String.check(Schema.isPattern(
  /^(?:0|-?[1-9][0-9]*)(?![\s\S])/
)).pipe(Schema.decodeTo(Schema.BigIntFromString))

const SnapshotMetadata = Schema.Struct({
  uid: Metadata.fields.uid,
  gid: Metadata.fields.gid,
  mode: Metadata.fields.mode,
  atimeNs: SnapshotInteger,
  mtimeNs: SnapshotInteger,
  ctimeNs: SnapshotInteger,
  birthtimeNs: SnapshotInteger
})
const SnapshotRecord = Schema.Union([
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("directory"),
    metadata: SnapshotMetadata,
    entries: Schema.Array(Schema.Struct({ name: SnapshotBytes, target: Schema.String }))
  }),
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("file"),
    metadata: SnapshotMetadata,
    data: SnapshotBytes
  }),
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("symlink"),
    metadata: SnapshotMetadata,
    target: SnapshotBytes
  })
])

// This checks record shapes and field codecs. It does not validate the graph,
// enforce decoder budgets, own the decoded buffers, or create an opaque Snapshot.
export const SnapshotImage = Schema.Struct({
  format: Schema.Literal("effect-vfs"),
  version: Schema.Literal(1),
  root: Schema.String,
  records: Schema.Array(SnapshotRecord)
})
export type SnapshotImage = typeof SnapshotImage.Type
export type SnapshotImageEncoded = typeof SnapshotImage.Encoded

// This model boundary returns SchemaError; the eventual codec maps ImageError.
export const decodeSnapshotImage = Schema.decodeUnknownEffect(SnapshotImage, { onExcessProperty: "error" })

/**
 * Fixture schemas: a declarative final state from which a volume is built.
 *
 * @since 0.6.0
 */
import * as Schema from "effect/Schema"
import { BytePath } from "./BytePath.js"
import { Mode, Timestamp } from "./Metadata.js"

/**
 * Schema for the metadata a fixture entry may pin; omitted fields take the
 * volume's defaults.
 *
 * @category schemas
 * @since 0.6.0
 */
export const FixtureMetadata = Schema.Struct({
  uid: Schema.optionalKey(Schema.Natural),
  gid: Schema.optionalKey(Schema.Natural),
  mode: Schema.optionalKey(Mode),
  atimeNs: Schema.optionalKey(Timestamp),
  mtimeNs: Schema.optionalKey(Timestamp),
  ctimeNs: Schema.optionalKey(Timestamp),
  birthtimeNs: Schema.optionalKey(Timestamp)
})

/**
 * Metadata a fixture entry pins.
 *
 * @category models
 * @since 0.6.0
 */
export type FixtureMetadata = typeof FixtureMetadata.Type

const FixturePath = Schema.Union([
  Schema.String,
  BytePath
])

/**
 * Schema for one fixture entry: a directory, a file with bytes, a symbolic
 * link, or a hard link to an earlier file entry.
 *
 * @category schemas
 * @since 0.6.0
 */
export const FixtureEntry = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("directory"),
    path: FixturePath,
    metadata: Schema.optionalKey(FixtureMetadata)
  }),
  Schema.Struct({
    kind: Schema.Literal("file"),
    path: FixturePath,
    bytes: Schema.Uint8Array,
    metadata: Schema.optionalKey(FixtureMetadata)
  }),
  Schema.Struct({
    kind: Schema.Literal("symlink"),
    path: FixturePath,
    target: FixturePath,
    metadata: Schema.optionalKey(FixtureMetadata)
  }),
  Schema.Struct({ kind: Schema.Literal("hardLink"), path: FixturePath, target: FixturePath })
]).pipe(Schema.toTaggedUnion("kind"))

/**
 * One fixture entry.
 *
 * @category models
 * @since 0.6.0
 */
export type FixtureEntry = typeof FixtureEntry.Type

/**
 * Schema for a whole fixture: optional root metadata and its entries in order.
 *
 * @category schemas
 * @since 0.6.0
 */
export const Fixture = Schema.Struct({
  rootMetadata: Schema.optionalKey(FixtureMetadata),
  entries: Schema.Array(FixtureEntry)
})

/**
 * A whole fixture.
 *
 * @category models
 * @since 0.6.0
 */
export type Fixture = typeof Fixture.Type

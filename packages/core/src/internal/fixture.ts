// Fixture image construction.
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { ImageError } from "../Snapshot.js"
import type { Fixture, PathInput, VolumeOptions } from "../VirtualFileSystem.js"
import { CanonicalBase64 } from "./canonicalBase64.js"
import { decodeConfiguration, OpContext } from "./errors.js"
import * as Image from "./image.js"
import { inputBytes, isAttachedBytes, isDotComponent, nameBytes, preparePath } from "./path.js"
import {
  Fixture as FixtureSchema,
  FixtureEntry,
  type FixtureMetadata,
  makeVolume,
  restoredSource,
  VolumeIdentity,
  VolumeOptions as VolumeOptionsSchema
} from "./virtualFileSystem.js"

const DEFAULT_MODE: Record<Image.Record["_tag"], number> = { directory: 0o755, file: 0o644, symlink: 0o777 }

const EPOCH_NS = 0n

/** @internal */
export const fromFixture = Effect.fn("VirtualFileSystem.fromFixture")(
  function*(fixture: Fixture, options?: VolumeOptions) {
    const config = yield* Effect.fromResult(decodeConfiguration(VolumeOptionsSchema, options ?? {}))

    const source = yield* Schema.decodeEffect(FixtureSchema, { onExcessProperty: "error" })(fixture).pipe(
      Effect.mapError((cause) => new ImageError({ code: "InvalidStructure", field: "fixture", cause }))
    )

    if (
      source.entries.some((entry) =>
        FixtureEntry.match(entry, {
          directory: () => false,
          file: ({ bytes }) => !isAttachedBytes(bytes),
          symlink: () => false,
          hardLink: () => false
        })
      )
    ) {
      return yield* new ImageError({ code: "InvalidEncoding", field: "bytes" })
    }

    const metadata = (
      kind: "directory" | "file" | "symlink",
      overrides?: typeof FixtureMetadata.Type
    ): Image.StoredMetadata => ({
      uid: overrides?.uid ?? 0,
      gid: overrides?.gid ?? 0,
      mode: overrides?.mode ?? DEFAULT_MODE[kind],
      atimeNs: overrides?.atimeNs ?? EPOCH_NS,
      mtimeNs: overrides?.mtimeNs ?? EPOCH_NS,
      ctimeNs: overrides?.ctimeNs ?? EPOCH_NS,
      birthtimeNs: overrides?.birthtimeNs ?? EPOCH_NS
    })

    const declarations = new Map<string, Image.Record>()
    const aliases = new Map<string, string>()
    const paths = new Map<string, ReadonlyArray<string>>()

    const root = Image.Record.cases.directory.make({
      id: "root",
      metadata: metadata("directory", source.rootMetadata),
      entries: []
    })

    declarations.set("", root)

    const op = OpContext.make("fixture")

    const fixturePath = (input: PathInput) =>
      preparePath(input, op.operation, config.maxPathBytes).pipe(
        Result.flatMap((path) =>
          !path.absolute || path.components.length === 0 ||
            path.components.some(isDotComponent)
            ? Result.fail(op.at(input).fail("InvalidArgument")) :
            Result.succeed(path.components)
        )
      )

    // Encode caller-owned byte buffers now: nothing below yields until Image.capture, so a caller
    // cannot mutate them first.
    for (const entry of source.entries) {
      const components = yield* Effect.fromResult(fixturePath(entry.path)).pipe(
        Effect.mapError((cause) => new ImageError({ code: "InvalidStructure", field: "path", cause }))
      )

      const key = components.join("/")

      if (paths.has(key)) return yield* new ImageError({ code: "InvalidStructure", field: "duplicate" })
      paths.set(key, components)

      const error = FixtureEntry.match(entry, {
        hardLink: ({ target }) => {
          const parsedTarget = fixturePath(target)

          if (Result.isFailure(parsedTarget)) {
            return new ImageError({ code: "InvalidStructure", field: "target", cause: parsedTarget.failure })
          }

          aliases.set(key, parsedTarget.success.join("/"))
        },
        directory: (entry) => {
          declarations.set(
            key,
            Image.Record.cases.directory.make({
              id: String(paths.size),
              metadata: metadata("directory", entry.metadata),
              entries: []
            })
          )
        },
        file: (entry) => {
          declarations.set(
            key,
            Image.Record.cases.file.make({
              id: String(paths.size),
              metadata: metadata("file", entry.metadata),
              data: CanonicalBase64.encode(entry.bytes)
            })
          )
        },
        symlink: ({ metadata: overrides, target: input }) => {
          const target = inputBytes(input)

          if (Result.isFailure(target)) {
            return new ImageError({
              code: target.failure === "InvalidPathEncoding" ? "InvalidEncoding" : "InvalidStructure",
              field: "target"
            })
          }

          if (target.success.includes(0)) return new ImageError({ code: "InvalidStructure", field: "target" })

          declarations.set(
            key,
            Image.Record.cases.symlink.make({
              id: String(paths.size),
              metadata: metadata("symlink", overrides),
              target: CanonicalBase64.encode(target.success)
            })
          )
        }
      })

      if (error instanceof ImageError) return yield* error
    }

    for (const [key] of aliases) {
      let target = key
      const seen = new Set<string>()

      while (!declarations.has(target)) {
        if (seen.has(target)) return yield* new ImageError({ code: "InvalidStructure", field: "hardLink" })
        seen.add(target)
        const next = aliases.get(target)

        if (next === undefined) return yield* new ImageError({ code: "InvalidStructure", field: "hardLink" })
        target = next
      }

      const node = declarations.get(target)

      if (node === undefined || Image.Record.guards.directory(node)) {
        return yield* new ImageError({ code: "InvalidStructure", field: "hardLink" })
      }

      for (const alias of seen) declarations.set(alias, node)
    }

    const children = new Map<string, Array<{ name: typeof CanonicalBase64.Encoded.Type; target: string }>>()

    for (const [key, components] of paths) {
      const parent = declarations.get(components.slice(0, -1).join("/"))
      const child = declarations.get(key)
      const name = components.at(-1)

      if (parent?._tag !== "directory" || child === undefined || name === undefined) {
        return yield* new ImageError({ code: "InvalidStructure", field: "parent" })
      }

      const entries = children.get(parent.id) ?? []
      entries.push({ name: CanonicalBase64.encode(nameBytes(name)), target: child.id })
      children.set(parent.id, entries)
    }

    const records = [...new Set(declarations.values())].map((record): Image.Record =>
      Image.Record.match<Image.Record>(record, {
        directory: (record) => ({ ...record, entries: children.get(record.id) ?? [] }),
        file: (record) => record,
        symlink: (record) => record
      })
    )

    const snapshot = yield* Image.capture({ format: "effect-vfs", version: 1, root: "root", records }, undefined, true)
    const image = yield* Image.inspect(snapshot)

    const { identity, ...volumeOptions } = config

    if (identity === undefined) return (yield* makeVolume(restoredSource(image), volumeOptions)).volume

    const { volume } = yield* makeVolume(restoredSource(image), {
      ...volumeOptions,
      identity: VolumeIdentity.make(identity)
    })

    return volume
  }
)

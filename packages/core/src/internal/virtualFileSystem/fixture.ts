// Fixture image construction.
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { ImageError } from "../../Snapshot.js"
import type { Fixture, PathInput, VolumeOptions } from "../../VirtualFileSystem.js"
import { getBytes as getBytePathBytes } from "../bytePath.js"
import * as Image from "../image.js"
import {
  Fixture as FixtureSchema,
  type FixtureMetadata,
  makeVolume,
  VolumeOptions as VolumeOptionsSchema,
  VolumeSource
} from "../virtualFileSystem.js"
import {
  attachedBuffer,
  decodeConfiguration,
  failure,
  isDotComponent,
  nameBytes,
  preparePath,
  wellFormed
} from "./path.js"

/** @internal */
export const fromFixture = Effect.fn("VirtualFileSystem.fromFixture")(
  function*(fixture: Fixture, options?: VolumeOptions) {
    const config = decodeConfiguration(VolumeOptionsSchema, options ?? {})

    if (Result.isFailure(config)) return yield* config.failure
    const decoded = Schema.decodeResult(FixtureSchema, { onExcessProperty: "error" })(fixture)

    if (Result.isFailure(decoded)) return yield* new ImageError({ code: "InvalidStructure", field: "fixture" })
    const source = decoded.success

    for (const entry of source.entries) {
      if (
        entry.kind === "file" && (!(entry.bytes.buffer instanceof ArrayBuffer) || !attachedBuffer(entry.bytes))
      ) return yield* new ImageError({ code: "InvalidEncoding", field: "bytes" })
    }

    const metadata = (
      kind: "directory" | "file" | "symlink",
      overrides?: typeof FixtureMetadata.Type
    ): Image.StoredMetadata => ({
      uid: overrides?.uid ?? 0,
      gid: overrides?.gid ?? 0,
      mode: overrides?.mode ?? (kind === "directory" ? 0o755 : kind === "file" ? 0o644 : 0o777),
      atimeNs: String(overrides?.atimeNs ?? 0n),
      mtimeNs: String(overrides?.mtimeNs ?? 0n),
      ctimeNs: String(overrides?.ctimeNs ?? 0n),
      birthtimeNs: String(overrides?.birthtimeNs ?? 0n)
    })

    const declarations = new Map<string, Image.Record>()
    const aliases = new Map<string, string>()
    const paths = new Map<string, ReadonlyArray<string>>()

    const root: Image.Record = {
      id: "root",
      kind: "directory",
      metadata: metadata("directory", source.rootMetadata),
      entries: []
    }

    declarations.set("", root)

    const fixturePath = (input: PathInput) =>
      preparePath(input, "fixture", config.success.maxPathBytes).pipe(
        Result.flatMap((path) =>
          !path.absolute || path.components.length === 0 ||
            path.components.some(isDotComponent)
            ? Result.fail(failure("InvalidArgument", "fixture", input)) :
            Result.succeed(path.components)
        )
      )

    // All byte inputs become immutable strings before the first successful suspension.
    for (const entry of source.entries) {
      const parsed = fixturePath(entry.path)

      if (Result.isFailure(parsed)) {
        return yield* new ImageError({ code: "InvalidStructure", field: "path" })
      }

      const components = parsed.success
      const key = components.join("/")

      if (paths.has(key)) return yield* new ImageError({ code: "InvalidStructure", field: "duplicate" })
      paths.set(key, components)

      if (entry.kind === "hardLink") {
        const target = fixturePath(entry.target)

        if (Result.isFailure(target)) return yield* new ImageError({ code: "InvalidStructure", field: "target" })
        aliases.set(key, target.success.join("/"))
      } else if (entry.kind === "directory") {
        declarations.set(key, {
          id: String(paths.size),
          kind: "directory",
          metadata: metadata("directory", entry.metadata),
          entries: []
        })
      } else if (entry.kind === "file") {
        declarations.set(key, {
          id: String(paths.size),
          kind: "file",
          metadata: metadata("file", entry.metadata),
          data: Image.base64(entry.bytes)
        })
      } else {
        if (Schema.is(Schema.String)(entry.target) && !wellFormed(entry.target)) {
          return yield* new ImageError({
            code: "InvalidEncoding",
            field: "target"
          })
        }

        const target = Schema.is(Schema.String)(entry.target)
          ? new TextEncoder().encode(entry.target)
          : getBytePathBytes(entry.target)

        if (target === undefined || target.includes(0)) {
          return yield* new ImageError({
            code: "InvalidStructure",
            field: "target"
          })
        }

        declarations.set(key, {
          id: String(paths.size),
          kind: "symlink",
          metadata: metadata("symlink", entry.metadata),
          target: Image.base64(target)
        })
      }
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

      if (node === undefined || node.kind === "directory") {
        return yield* new ImageError({
          code: "InvalidStructure",
          field: "hardLink"
        })
      }

      for (const alias of seen) declarations.set(alias, node)
    }

    const children = new Map<string, Array<{ name: string; target: string }>>()

    for (const [key, components] of paths) {
      const parent = declarations.get(components.slice(0, -1).join("/"))
      const child = declarations.get(key)
      const name = components.at(-1)

      if (parent?.kind !== "directory" || child === undefined || name === undefined) {
        return yield* new ImageError({ code: "InvalidStructure", field: "parent" })
      }

      const entries = children.get(parent.id) ?? []
      entries.push({ name: Image.base64(nameBytes(name)), target: child.id })
      children.set(parent.id, entries)
    }

    const records = [...new Set(declarations.values())].map((record): Image.Record =>
      record.kind === "directory" ? { ...record, entries: children.get(record.id) ?? [] } : record
    )

    const snapshot = yield* Image.capture({ format: "effect-vfs", version: 1, root: "root", records })
    const image = yield* Image.inspect(snapshot)

    return yield* makeVolume(VolumeSource.Snapshot({ image }), config.success)
  }
)

// Fixture image construction.
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type { Fixture, PathInput, VolumeOptions } from "../../VirtualFileSystem.js"
import * as Image from "../image.js"
import {
  Fixture as FixtureSchema,
  type FixtureMetadata,
  makeVolume,
  VolumeOptions as VolumeOptionsSchema,
  VolumeSource
} from "../virtualFileSystem.js"
import { decodeConfiguration } from "./errors.js"
import { failure, inputBytes, isAttachedBytes, isDotComponent, nameBytes, preparePath } from "./path.js"

const DEFAULT_MODE: Record<Image.Record["kind"], number> = { directory: 0o755, file: 0o644, symlink: 0o777 }

const EPOCH_NS = 0n

/** @internal */
export const fromFixture = Effect.fn("VirtualFileSystem.fromFixture")(
  function*(fixture: Fixture, options?: VolumeOptions) {
    const config = decodeConfiguration(VolumeOptionsSchema, options ?? {})

    if (Result.isFailure(config)) return yield* config.failure
    const decoded = Schema.decodeResult(FixtureSchema, { onExcessProperty: "error" })(fixture)

    if (Result.isFailure(decoded)) return yield* Image.error("InvalidStructure", "fixture")
    const source = decoded.success

    for (const entry of source.entries) {
      if (entry.kind === "file" && !isAttachedBytes(entry.bytes)) {
        return yield* Image.error("InvalidEncoding", "bytes")
      }
    }

    const metadata = (
      kind: "directory" | "file" | "symlink",
      overrides?: typeof FixtureMetadata.Type
    ): Image.StoredMetadata => ({
      uid: overrides?.uid ?? 0,
      gid: overrides?.gid ?? 0,
      mode: overrides?.mode ?? DEFAULT_MODE[kind],
      atimeNs: String(overrides?.atimeNs ?? EPOCH_NS),
      mtimeNs: String(overrides?.mtimeNs ?? EPOCH_NS),
      ctimeNs: String(overrides?.ctimeNs ?? EPOCH_NS),
      birthtimeNs: String(overrides?.birthtimeNs ?? EPOCH_NS)
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

    // Encode caller-owned byte buffers now: nothing below yields until Image.capture, so a caller
    // cannot mutate them first.
    for (const entry of source.entries) {
      const parsed = fixturePath(entry.path)

      if (Result.isFailure(parsed)) {
        return yield* Image.error("InvalidStructure", "path")
      }

      const components = parsed.success
      const key = components.join("/")

      if (paths.has(key)) return yield* Image.error("InvalidStructure", "duplicate")
      paths.set(key, components)

      if (entry.kind === "hardLink") {
        const target = fixturePath(entry.target)

        if (Result.isFailure(target)) return yield* Image.error("InvalidStructure", "target")
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
        entry.kind satisfies "symlink"
        const target = inputBytes(entry.target)

        if (Result.isFailure(target)) {
          return yield* Image.error(
            target.failure === "InvalidPathEncoding" ? "InvalidEncoding" : "InvalidStructure",
            "target"
          )
        }

        if (target.success.includes(0)) return yield* Image.error("InvalidStructure", "target")

        declarations.set(key, {
          id: String(paths.size),
          kind: "symlink",
          metadata: metadata("symlink", entry.metadata),
          target: Image.base64(target.success)
        })
      }
    }

    for (const [key] of aliases) {
      let target = key
      const seen = new Set<string>()

      while (!declarations.has(target)) {
        if (seen.has(target)) return yield* Image.error("InvalidStructure", "hardLink")
        seen.add(target)
        const next = aliases.get(target)

        if (next === undefined) return yield* Image.error("InvalidStructure", "hardLink")
        target = next
      }

      const node = declarations.get(target)

      if (node === undefined || node.kind === "directory") {
        return yield* Image.error("InvalidStructure", "hardLink")
      }

      for (const alias of seen) declarations.set(alias, node)
    }

    const children = new Map<string, Array<{ name: string; target: string }>>()

    for (const [key, components] of paths) {
      const parent = declarations.get(components.slice(0, -1).join("/"))
      const child = declarations.get(key)
      const name = components.at(-1)

      if (parent?.kind !== "directory" || child === undefined || name === undefined) {
        return yield* Image.error("InvalidStructure", "parent")
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

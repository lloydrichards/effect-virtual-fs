import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { Fixture as FixtureSchema, FixtureEntry, type FixtureMetadata } from "../Fixture.js"
import type { Fixture, PathInput, VolumeOptions } from "../VirtualFileSystem.js"
import { VolumeIdentity, VolumeOptions as VolumeOptionsSchema } from "../Volume.js"
import { decodeConfiguration, imageFailure, OpContext, VfsError } from "./errors.js"
import type { StoredMetadata } from "./metadata.js"
import { inputBytes, isAttachedBytes, isDotComponent, preparePath } from "./path.js"
import { makeVolume, VolumeSource } from "./virtualFileSystem.js"
import { assemble, Ino, type Link, type NodeSpec, ROOT_INO } from "./volumeState.js"

const DEFAULT_MODE: Record<NodeSpec["kind"], number> = { directory: 0o755, file: 0o644, symlink: 0o777 }
const EPOCH_NS = 0n

interface Declared {
  readonly kind: NodeSpec["kind"]
  readonly ino: Ino
  readonly metadata: StoredMetadata
  readonly payload?: Uint8Array
}

/** @internal */
export const fromFixture = Effect.fn("VirtualFileSystem.fromFixture")(
  function*(fixture: Fixture, options?: VolumeOptions) {
    const config = yield* Effect.fromResult(decodeConfiguration(VolumeOptionsSchema, options ?? {}, "fromFixture"))

    const source = yield* Schema.decodeEffect(FixtureSchema, { onExcessProperty: "error" })(fixture).pipe(
      Effect.mapError((cause) => imageFailure("fromFixture", "InvalidStructure", { field: "fixture", cause }))
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
      return yield* imageFailure("fromFixture", "InvalidEncoding", { field: "bytes" })
    }

    const metadata = (kind: NodeSpec["kind"], overrides?: FixtureMetadata): StoredMetadata => ({
      uid: overrides?.uid ?? 0,
      gid: overrides?.gid ?? 0,
      mode: overrides?.mode ?? DEFAULT_MODE[kind],
      atimeNs: overrides?.atimeNs ?? EPOCH_NS,
      mtimeNs: overrides?.mtimeNs ?? EPOCH_NS,
      ctimeNs: overrides?.ctimeNs ?? EPOCH_NS,
      birthtimeNs: overrides?.birthtimeNs ?? EPOCH_NS
    })

    // Assign inode numbers in declaration order, before resolving hard links.
    const declarations = new Map<string, Declared>()
    const aliases = new Map<string, string>()
    const paths = new Map<string, ReadonlyArray<string>>()
    let nextInode = ROOT_INO

    const declare = (declared: Omit<Declared, "ino">): Declared => {
      nextInode = Ino(nextInode + 1)

      return { ...declared, ino: nextInode }
    }

    declarations.set("", { kind: "directory", ino: ROOT_INO, metadata: metadata("directory", source.rootMetadata) })

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

    // Copy caller-owned bytes before storing them.
    for (const entry of source.entries) {
      const components = yield* Effect.fromResult(fixturePath(entry.path)).pipe(
        Effect.mapError((cause) => imageFailure("fromFixture", "InvalidStructure", { field: "path", cause }))
      )

      const key = components.join("/")

      if (paths.has(key)) return yield* imageFailure("fromFixture", "InvalidStructure", { field: "duplicate" })
      paths.set(key, components)

      const error = FixtureEntry.match(entry, {
        hardLink: ({ target }) => {
          const parsedTarget = fixturePath(target)

          if (Result.isFailure(parsedTarget)) {
            return imageFailure("fromFixture", "InvalidStructure", { field: "target", cause: parsedTarget.failure })
          }

          aliases.set(key, parsedTarget.success.join("/"))
        },
        directory: (entry) => {
          declarations.set(key, declare({ kind: "directory", metadata: metadata("directory", entry.metadata) }))
        },
        file: (entry) => {
          declarations.set(
            key,
            declare({ kind: "file", metadata: metadata("file", entry.metadata), payload: entry.bytes.slice() })
          )
        },
        symlink: ({ metadata: overrides, target: input }) => {
          const target = inputBytes(input)

          if (Result.isFailure(target)) {
            return imageFailure(
              "fromFixture",
              target.failure === "InvalidPathEncoding" ? "InvalidEncoding" : "InvalidStructure",
              { field: "target" }
            )
          }

          if (target.success.includes(0)) return imageFailure("fromFixture", "InvalidStructure", { field: "target" })

          declarations.set(
            key,
            declare({ kind: "symlink", metadata: metadata("symlink", overrides), payload: target.success.slice() })
          )
        }
      })

      if (Schema.is(VfsError)(error)) return yield* error
    }

    for (const [key] of aliases) {
      let target = key
      const seen = new Set<string>()

      while (!declarations.has(target)) {
        if (seen.has(target)) return yield* imageFailure("fromFixture", "InvalidStructure", { field: "hardLink" })
        seen.add(target)
        const next = aliases.get(target)

        if (next === undefined) return yield* imageFailure("fromFixture", "InvalidStructure", { field: "hardLink" })
        target = next
      }

      const node = declarations.get(target)

      if (node === undefined || node.kind === "directory") {
        return yield* imageFailure("fromFixture", "InvalidStructure", { field: "hardLink" })
      }

      for (const alias of seen) declarations.set(alias, node)
    }

    const names = new Map<Declared, Array<Link>>()

    for (const [key, components] of paths) {
      const parent = declarations.get(components.slice(0, -1).join("/"))
      const child = declarations.get(key)
      const name = components.at(-1)

      if (parent?.kind !== "directory" || child === undefined || name === undefined) {
        return yield* imageFailure("fromFixture", "InvalidStructure", { field: "parent" })
      }

      names.set(child, [...(names.get(child) ?? []), { parent: parent.ino, name }])
    }

    const specs = [...new Set(declarations.values())].map((declared): NodeSpec => {
      const links = names.get(declared) ?? []
      const common = { ino: declared.ino, metadata: declared.metadata, revision: 1n }

      if (declared.kind === "directory") {
        // The root has no path; directories cannot have hard links.
        const [link = { parent: ROOT_INO, name: "" }] = links

        return { ...common, kind: "directory", parent: link.parent, name: link.name }
      }

      const payload = declared.payload ?? new Uint8Array()

      return declared.kind === "file"
        ? { ...common, kind: "file", links, data: payload }
        : { ...common, kind: "symlink", links, target: payload }
    })

    const restored = VolumeSource.Restored({ value: assemble(specs) })

    const { identity, ...volumeOptions } = config

    if (identity === undefined) return (yield* makeVolume(restored, volumeOptions)).volume

    const { volume } = yield* makeVolume(restored, {
      ...volumeOptions,
      identity: VolumeIdentity.make(identity)
    })

    return volume
  }
)

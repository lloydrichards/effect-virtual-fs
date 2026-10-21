/**
 * Caller-based traversal for FileSystem.copy. Public tree transfers have a separate engine.
 *
 * @internal
 * @since 0.9.0
 */
import * as BytePath from "@effect-vfs/core/BytePath"
import { VfsError } from "@effect-vfs/core/VfsError"
import type * as Vfs from "@effect-vfs/core/VirtualFileSystem"
import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Result from "effect/Result"
import * as Scope from "effect/Scope"
import { at } from "./adapterSupport.js"

interface Written {
  readonly name: Vfs.PathInput
  readonly base: Vfs.DirectoryHandle | undefined
}

interface Directory {
  readonly reference: Vfs.ObjectReference
  readonly metadata: Vfs.Metadata
  readonly created: boolean
}

const targetOf = (written: Written) => at(written.name, { relativeTo: written.base, followFinalSymlink: false })

const noSpace = () => new VfsError({ code: "NoSpace", operation: "copy" })

const exceeds = (value: number | bigint, limit: ByteSize.ByteSize | undefined) =>
  limit !== undefined && BigInt(value) > ByteSize.toBigInt(limit)

// Permission changes address observed objects, never a name that might now hold a replacement.
// The core recursive remover guards the root and each child identity at every removal stage.
const removeClaimed = Effect.fnUntraced(function*(
  caller: Vfs.Caller,
  destination: Vfs.PathInput,
  reference: Vfs.ObjectReference,
  directories: ReadonlyArray<Directory>
) {
  const current = yield* Effect.result(caller.lookup(destination))

  if (Result.isFailure(current)) {
    if (current.failure.code === "NotFound") return

    return yield* current.failure
  }

  if (current.success !== reference) return
  const restored: Array<{ reference: Vfs.ObjectReference; mode: number }> = []

  const prepare = Effect.gen(function*() {
    // Only copy-created directories need their finalized restrictive modes reopened.
    // Leave listing and child identity capture to the guarded core removal walk.
    for (const directory of directories) {
      if (!directory.created) continue
      const metadata = yield* Effect.result(caller.stat(directory.reference))

      if (Result.isFailure(metadata)) {
        if (metadata.failure.code === "StaleReference") continue

        return yield* metadata.failure
      }

      restored.push({ reference: directory.reference, mode: metadata.success.mode })
      yield* caller.chmod(directory.reference, metadata.success.mode | 0o700)
    }

    yield* caller.remove(destination, { recursive: true, expected: reference })
  })

  yield* prepare.pipe(Effect.ensuring(
    Effect.suspend(() =>
      Effect.forEach(
        [...restored].reverse(),
        (entry) => caller.chmod(entry.reference, entry.mode).pipe(Effect.ignore),
        { discard: true }
      )
    )
  ))
})

/** @internal */
export const copyTree = Effect.fnUntraced(function*(
  caller: Vfs.Caller,
  source: string,
  destination: string,
  limits: Vfs.VolumeLimits,
  options: Parameters<FileSystem.FileSystem["copy"]>[2]
) {
  return yield* Effect.scoped(Effect.gen(function*() {
    const handles = yield* Scope.make()
    const directories: Array<Directory> = []
    const aliases = new Map<bigint, Written>()

    const pending: Array<{ source: Vfs.PathInput; destination: Written; pathBytes: number }> = [{
      source,
      destination: { name: destination, base: undefined },
      pathBytes: 1
    }]

    let claimed: Vfs.ObjectReference | undefined
    let completed = false
    let entries = 0
    let bytes = 0n
    const create = options?.overwrite ? "ifMissing" : "exclusive"

    const applyTimes = (target: Vfs.TargetInput, metadata: Vfs.Metadata) =>
      options?.preserveTimestamps
        ? caller.utimes(target, {
          access: { kind: "value", nanoseconds: metadata.atimeNs },
          modification: { kind: "value", nanoseconds: metadata.mtimeNs }
        })
        : Effect.void

    yield* Effect.addFinalizer((exit) => {
      const cleanup = completed ? Effect.void : claimed !== undefined
        ? removeClaimed(caller, destination, claimed, directories)
        : Effect.forEach([...directories].reverse(), (directory) =>
          directory.created
            ? caller.chmod(directory.reference, directory.metadata.mode).pipe(Effect.ignore)
            : Effect.void, { discard: true })

      return cleanup.pipe(Effect.orDie, Effect.ensuring(Scope.close(handles, exit)))
    })

    const clearExisting = Effect.fnUntraced(function*(target: Vfs.PathTarget) {
      const current = yield* Effect.result(caller.lookup(target))

      if (Result.isFailure(current)) {
        if (current.failure.code === "NotFound") return

        return yield* current.failure
      }

      if ((yield* caller.stat(current.success)).kind === "directory") {
        return yield* new VfsError({ code: "IsDirectory", operation: "copy" })
      }

      yield* caller.remove(target, { expected: current.success })
    })

    while (pending.length > 0) {
      const next = pending.pop()!
      entries++

      if (entries > (limits.maxEntries ?? Number.MAX_SAFE_INTEGER) || exceeds(next.pathBytes, limits.maxPathBytes)) {
        return yield* noSpace()
      }

      const sourceTarget = at(next.source, { followFinalSymlink: false })
      // Reads can refresh relatime, so retain metadata before listing or reading contents.
      const metadata = yield* caller.stat(sourceTarget)
      const written = next.destination
      const target = targetOf(written)
      const root = written.base === undefined

      if (metadata.kind === "directory") {
        const children = [...(yield* caller.readDirectory(sourceTarget)).value]
          .sort((left, right) => BytePath.byteOrder(left.name, right.name))

        if (entries + pending.length + children.length > (limits.maxEntries ?? Number.MAX_SAFE_INTEGER)) {
          return yield* noSpace()
        }

        const reference = yield* Effect.uninterruptible(Effect.gen(function*() {
          const made = yield* Effect.result(caller.mkdir(target, { mode: metadata.mode | 0o700 }))
          const created = Result.isSuccess(made)

          if (Result.isFailure(made) && (!options?.overwrite || made.failure.code !== "AlreadyExists")) {
            return yield* made.failure
          }

          const reference = created ? made.success.reference : yield* caller.lookup(target)

          if (root && created && !options?.overwrite) claimed = reference

          if (!created && (yield* caller.stat(reference)).kind !== "directory") {
            return yield* new VfsError({ code: "NotDirectory", operation: "copy" })
          }

          directories.push({ reference, metadata, created })

          return reference
        }))

        const base = yield* Scope.provide(caller.openDirectory(reference), handles)
        const sourceBytes = yield* BytePath.toBytes(yield* BytePath.fromInput(next.source))

        for (let index = children.length - 1; index >= 0; index--) {
          const child = children[index]!
          const separator = sourceBytes.at(-1) === 0x2f ? 0 : 1
          const childSource = new Uint8Array(sourceBytes.length + separator + child.name.length)
          childSource.set(sourceBytes)

          if (separator !== 0) childSource[sourceBytes.length] = 0x2f
          childSource.set(child.name, sourceBytes.length + separator)
          pending.push({
            source: yield* BytePath.fromBytes(childSource),
            destination: { name: yield* BytePath.fromBytes(child.name), base },
            pathBytes: next.pathBytes === 1 ? 1 + child.name.length : next.pathBytes + 1 + child.name.length
          })
        }

        continue
      }

      const alias = metadata.nlink > 1 ? aliases.get(metadata.ino) : undefined

      if (alias !== undefined) {
        if (options?.overwrite) yield* clearExisting(target)
        yield* caller.link(targetOf(alias), target)
        continue
      }

      if (metadata.kind === "file") {
        if (exceeds(metadata.size, limits.maxFileBytes)) return yield* noSpace()
        const contents = yield* caller.readFile(sourceTarget)
        bytes += BigInt(contents.length)

        if (exceeds(contents.length, limits.maxFileBytes) || exceeds(bytes, limits.maxBytes)) return yield* noSpace()

        const writing = caller.writeFile(target, contents, {
          access: "write",
          create,
          truncate: true,
          mode: metadata.mode,
          finalMode: metadata.mode,
          replaceFinalSymlink: true
        })

        if (root) {
          yield* Effect.uninterruptible(Effect.gen(function*() {
            yield* writing

            if (!options?.overwrite) claimed = yield* caller.lookup(target)
          }))
        } else yield* writing
      } else {
        const link = yield* caller.readLink(sourceTarget)
        bytes += BigInt(link.length)

        if (exceeds(bytes, limits.maxBytes)) return yield* noSpace()

        if (options?.overwrite) yield* clearExisting(target)

        const creating = Effect.gen(function*() {
          const made = yield* caller.symlink(yield* BytePath.fromBytes(link), target)

          if (root && !options?.overwrite) claimed = made.reference
        })

        yield* root ? Effect.uninterruptible(creating) : creating
        yield* caller.chmod(target, metadata.mode)
      }

      if (metadata.nlink > 1) aliases.set(metadata.ino, written)
      yield* applyTimes(target, metadata)
    }

    yield* Effect.uninterruptible(Effect.gen(function*() {
      for (const directory of [...directories].reverse()) {
        if (directory.created && (yield* caller.stat(directory.reference)).mode !== directory.metadata.mode) {
          yield* caller.chmod(directory.reference, directory.metadata.mode)
        }

        yield* applyTimes(directory.reference, directory.metadata)
      }

      completed = true
    }))
  }))
})

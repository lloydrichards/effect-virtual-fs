/**
 * Before-and-after examples using the implemented bound dual methods. Separate
 * function families below remain local design alternatives, not public APIs.
 */
import type { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { Effect, pipe } from "effect"
import { dual } from "effect/Function"

const bytes = new TextEncoder().encode("release notes")

const options = { access: "write", create: "exclusive" } as const satisfies Vfs.WriteFileOptions

export const before = (caller: Vfs.Caller, path: Effect.Effect<string>) =>
  path.pipe(Effect.flatMap((entry) => caller.writeFile(entry, bytes, options)))

export const afterBoundMethods = (caller: Vfs.Caller, path: Effect.Effect<string>) =>
  path.pipe(Effect.flatMap(caller.writeFile(bytes, options)))

/** A reusable writer captures the same contents and options for many paths. */
export const writeManyPaths = (caller: Vfs.Caller, paths: ReadonlyArray<string>) => {
  const writeReleaseNotes = caller.writeFile(bytes, options)

  return Effect.forEach(paths, writeReleaseNotes)
}

/** Reads already compose today; adding dual would not shorten this. */
export const readToday = (caller: Vfs.Caller, path: Effect.Effect<string>) => path.pipe(Effect.flatMap(caller.readFile))

/** Rename captures one destination, so do not reuse this for many source files. */
export const moveTo = (caller: Vfs.Caller, source: Effect.Effect<string>) =>
  source.pipe(Effect.flatMap(caller.rename("/archive/release.md")))

/**
 * Separate functions with the caller as explicit configuration and the target
 * as data. These also preserve the current direct method argument order.
 */
export namespace TargetFunctions {
  export const writeFile: {
    (entry: Vfs.EntryInput, caller: Vfs.Caller, bytes: Uint8Array, options: Vfs.WriteFileOptions): ReturnType<
      Vfs.Caller["writeFile"]
    >
    (caller: Vfs.Caller, bytes: Uint8Array, options: Vfs.WriteFileOptions): (
      entry: Vfs.EntryInput
    ) => ReturnType<Vfs.Caller["writeFile"]>
  } = dual(
    4,
    (entry: Vfs.EntryInput, caller: Vfs.Caller, contents: Uint8Array, settings: Vfs.WriteFileOptions) =>
      caller.writeFile(entry, contents, settings)
  )
}

export const afterTargetFunctions = (caller: Vfs.Caller, path: Effect.Effect<string>) =>
  path.pipe(Effect.flatMap(TargetFunctions.writeFile(caller, bytes, options)))

/** Conventional receiver-first functions make the caller itself the data. */
export namespace CallerFunctions {
  export const readFile: {
    (caller: Vfs.Caller, target: Vfs.TargetInput): ReturnType<Vfs.Caller["readFile"]>
    (target: Vfs.TargetInput): (caller: Vfs.Caller) => ReturnType<Vfs.Caller["readFile"]>
  } = dual(2, (caller: Vfs.Caller, target: Vfs.TargetInput) => caller.readFile(target))
}

export const afterCallerFunctions = (caller: Effect.Effect<Vfs.Caller, Vfs.FsFailure>) =>
  caller.pipe(Effect.flatMap(CallerFunctions.readFile("/release.md")))

/** With an already available caller, its bound method is shorter. */
export const compareRead = (caller: Vfs.Caller) => ({
  bound: caller.readFile("/release.md"),
  separate: pipe(caller, CallerFunctions.readFile("/release.md"))
})

/** Positional writes take bytes as data while capturing an offset. */
export const positional = (handle: Vfs.FileHandle) => {
  const pwrite = handle.pwrite

  return {
    before: (contents: Effect.Effect<Uint8Array>) => contents.pipe(Effect.flatMap((value) => handle.pwrite(value, 0n))),
    after: (contents: Effect.Effect<Uint8Array>) => contents.pipe(Effect.flatMap(pwrite(0n))),
    cursorWriteToday: (contents: Effect.Effect<Uint8Array>) => contents.pipe(Effect.flatMap(handle.write))
  }
}

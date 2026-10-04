import { BytePath, type VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { Effect, Option, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"

export const maxTextBytes = 64 * 1024

export const maxDirectoryEntries = 200

const encoder = new TextEncoder()

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

export const ToolFailure = Schema.Struct({
  code: Schema.String,
  operation: Schema.String,
  message: Schema.String,
  path: Schema.optionalKey(Schema.String),
  field: Schema.optionalKey(Schema.String)
})

type Failure = typeof ToolFailure.Type

type MutableFailure = { -readonly [K in keyof Failure]: Failure[K] }

const Path = Schema.Struct({ path: Schema.String })

const TextResult = Schema.Struct({ path: Schema.String, content: Schema.String })

const Acknowledgement = Schema.Struct({ path: Schema.String, message: Schema.String })

const DirectoryResult = Schema.Struct({
  path: Schema.String,
  entries: Schema.Array(Schema.Struct({ name: Schema.String, kind: Schema.Literals(["file", "directory", "symlink"]) }))
})

const Read = Tool.make("read_file", {
  description: "Read a UTF-8 file, at most 64 KiB. Paths are project-relative.",
  parameters: Path,
  success: TextResult,
  failure: ToolFailure,
  failureMode: "return"
})
  .annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.OpenWorld, false)

const Write = Tool.make("write_file", {
  description: "Create or replace a UTF-8 file, at most 64 KiB. The parent directory must exist.",
  parameters: Schema.Struct({ path: Schema.String, content: Schema.String }),
  success: Acknowledgement,
  failure: ToolFailure,
  failureMode: "return"
})
  .annotate(Tool.Destructive, true).annotate(Tool.OpenWorld, false)

const List = Tool.make("list_directory", {
  description: "List at most 200 entries with UTF-8 names. Use '.' for the project root.",
  parameters: Path,
  success: DirectoryResult,
  failure: ToolFailure,
  failureMode: "return"
})
  .annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.OpenWorld, false)

const Stat = Tool.make("stat", {
  description:
    "Inspect metadata, following symbolic links. Size and modification time are decimal strings; time is Unix nanoseconds.",
  parameters: Path,
  success: Schema.Struct({
    path: Schema.String,
    kind: Schema.Literals(["file", "directory", "symlink"]),
    size: Schema.String,
    mode: Schema.Natural,
    mtimeNs: Schema.String
  }),
  failure: ToolFailure,
  failureMode: "return"
})
  .annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.OpenWorld, false)

const Mkdir = Tool.make("create_directory", {
  description: "Create a directory and missing parent directories.",
  parameters: Path,
  success: Acknowledgement,
  failure: ToolFailure,
  failureMode: "return"
})
  .annotate(Tool.Destructive, false).annotate(Tool.OpenWorld, false)

const Remove = Tool.make("remove", {
  description: "Remove a file, symbolic link, or empty directory. Missing paths and nonempty directories fail.",
  parameters: Path,
  success: Acknowledgement,
  failure: ToolFailure,
  failureMode: "return"
})
  .annotate(Tool.Destructive, true).annotate(Tool.OpenWorld, false)

const Rename = Tool.make("rename", {
  description: "Move an entry, replacing a compatible destination. Destination parents must exist.",
  parameters: Schema.Struct({ from: Schema.String, to: Schema.String }),
  success: Schema.Struct({ from: Schema.String, to: Schema.String, message: Schema.String }),
  failure: ToolFailure,
  failureMode: "return"
})
  .annotate(Tool.Destructive, true).annotate(Tool.OpenWorld, false)

const InspectBase = Tool.make("inspect_base", {
  description:
    "Read or list the unchanged base snapshot, independently of overlay edits. The same read/list limits apply.",
  parameters: Schema.Struct({ path: Schema.String, action: Schema.Literals(["read", "list"]) }),
  success: Schema.Union([TextResult, DirectoryResult]),
  failure: ToolFailure,
  failureMode: "return"
})
  .annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.OpenWorld, false)

export const VolumeTools = Toolkit.make(Read, Write, List, Stat, Mkdir, Remove, Rename, InspectBase)

const inputPath = Effect.fn("Tools.path")(function*(path: string, operation: string) {
  if (
    path.startsWith("/") || path.split("/").includes("..") || path.includes("\0") ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(path)
  ) {
    return yield* Effect.fail<Failure>({
      code: "InvalidToolPath",
      operation,
      path,
      message: "Use a UTF-8 project-relative path without '..' or NUL."
    })
  }

  return path.split("/").filter((part) => part !== "" && part !== ".").join("/") || "."
})

const fsFailure = (error: Vfs.FsFailure): Failure => {
  const failure: MutableFailure = {
    code: error.code,
    operation: error.operation,
    message: error.message
  }

  if (error.path !== undefined) {
    const path = BytePath.toStringOption(error.path)

    if (Option.isSome(path)) failure.path = path.value
  }

  if (error.field !== undefined) failure.field = error.field

  return failure
}

const readText = Effect.fn("Tools.readText")(function*(caller: Vfs.Caller, path: string, operation: string) {
  const content = yield* Effect.scoped(Effect.gen(function*() {
    const handle = yield* caller.open(path, { access: "read" }).pipe(Effect.mapError(fsFailure))
    const bytes = yield* handle.read(maxTextBytes + 1).pipe(Effect.mapError(fsFailure))

    if (bytes.length > maxTextBytes) {
      return yield* Effect.fail<Failure>({
        code: "TextLimitExceeded",
        operation,
        path,
        message: "File exceeds the 64 KiB text limit."
      })
    }

    return yield* Effect.try({
      try: () => decoder.decode(bytes),
      catch: (): Failure => ({ code: "InvalidTextEncoding", operation, path, message: "File is not valid UTF-8." })
    })
  }))

  return { path, content }
})

const listEntries = Effect.fn("Tools.listEntries")(function*(caller: Vfs.Caller, path: string, operation: string) {
  const listing = yield* caller.readDirectory(path).pipe(Effect.mapError(fsFailure))

  if (listing.value.length > maxDirectoryEntries) {
    return yield* Effect.fail<Failure>({
      code: "DirectoryLimitExceeded",
      operation,
      path,
      message: "Directory exceeds the 200-entry limit."
    })
  }

  const entries = yield* Effect.forEach(
    listing.value,
    Effect.fnUntraced(function*(entry) {
      const name = yield* Effect.try({
        try: () => decoder.decode(entry.name),
        catch: (): Failure => ({
          code: "InvalidNameEncoding",
          operation,
          path,
          message: "Directory contains a name that is not valid UTF-8."
        })
      })

      const metadata = yield* caller.stat(entry.reference).pipe(Effect.mapError(fsFailure))

      return { name, kind: metadata.kind }
    })
  )

  return { path, entries }
})

// Tool paths are relative to each caller’s assigned root, including symbolic-link lookup.
export const handlersFor = (caller: Vfs.Caller, baseCaller: Vfs.Caller) =>
  VolumeTools.of({
    read_file: Effect.fn("Tools.read")(function*({ path }) {
      return yield* readText(caller, yield* inputPath(path, "read_file"), "read_file")
    }),
    write_file: Effect.fn("Tools.write")(function*({ path, content }) {
      const relative = yield* inputPath(path, "write_file")
      const bytes = encoder.encode(content)

      if (bytes.length > maxTextBytes) {
        return yield* Effect.fail<Failure>({
          code: "TextLimitExceeded",
          operation: "write_file",
          path: relative,
          message: "Content exceeds the 64 KiB text limit."
        })
      }

      // Reject lone surrogates rather than silently replacing them during UTF-8 encoding.
      if (decoder.decode(bytes) !== content) {
        return yield* Effect.fail<Failure>({
          code: "InvalidTextEncoding",
          operation: "write_file",
          path: relative,
          message: "Content cannot be represented as UTF-8 without replacement."
        })
      }

      yield* caller.writeFile(relative, bytes, { access: "write", create: "ifMissing", truncate: true }).pipe(
        Effect.mapError(fsFailure)
      )

      return { path: relative, message: `Wrote ${relative}` }
    }),
    list_directory: Effect.fn("Tools.list")(function*({ path }) {
      return yield* listEntries(caller, yield* inputPath(path, "list_directory"), "list_directory")
    }),
    stat: Effect.fn("Tools.stat")(function*({ path }) {
      const relative = yield* inputPath(path, "stat")
      const metadata = yield* caller.stat(relative).pipe(Effect.mapError(fsFailure))

      return {
        path: relative,
        kind: metadata.kind,
        size: String(metadata.size),
        mode: metadata.mode,
        mtimeNs: String(metadata.mtimeNs)
      }
    }),
    create_directory: Effect.fn("Tools.mkdir")(function*({ path }) {
      const relative = yield* inputPath(path, "create_directory")
      yield* caller.mkdir(relative, { recursive: true }).pipe(Effect.mapError(fsFailure))

      return { path: relative, message: `Created directory ${relative}` }
    }),
    remove: Effect.fn("Tools.remove")(function*({ path }) {
      const relative = yield* inputPath(path, "remove")
      yield* caller.remove(relative).pipe(Effect.mapError(fsFailure))

      return { path: relative, message: `Removed ${relative}` }
    }),
    rename: Effect.fn("Tools.rename")(function*({ from, to }) {
      const source = yield* inputPath(from, "rename")
      const destination = yield* inputPath(to, "rename")
      yield* caller.rename(source, destination).pipe(Effect.mapError(fsFailure))

      return { from: source, to: destination, message: `Moved ${source} to ${destination}` }
    }),
    inspect_base: Effect.fn("Tools.inspectBase")(function*({ path, action }) {
      const relative = yield* inputPath(path, "inspect_base")

      return action === "read"
        ? yield* readText(baseCaller, relative, "inspect_base")
        : yield* listEntries(baseCaller, relative, "inspect_base")
    })
  })

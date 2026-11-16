import { Cause, Effect, Exit } from "effect"
import * as Atom from "effect/reactivity/Atom"
import { buildWorkspace } from "./build"
import { PlaygroundError } from "./error"
import { deleteCheckpoint, hasSavedCheckpoint, readCheckpoint, saveCheckpoint } from "./storage"
import { type FileAccess, openVolume, type Workspace } from "./volume"

export type Entry = Effect.Success<ReturnType<FileAccess["files"]>>[number]

export type Operation = "New file" | "New folder" | "Rename file" | "Rename folder"

type Role = "admin" | "editor" | "reader"

type Command =
  | "open"
  | "save"
  | "inspect"
  | "reopen"
  | "deleteCheckpoint"
  | "build"
  | "deleteEntry"
  | { role: Role }
  | { select: Entry }
  | { operation: Operation; name: string }

interface Playground {
  volume?: Workspace
  role: Role
  entries: ReadonlyArray<Entry>
  path: string
  folder: string
  source: string
  permissions: number
  dirty: boolean
  busy: boolean
  status: string
  error: string
  output: string
}

export const playgroundAtom = Atom.make<Playground>({
  role: "admin",
  entries: [],
  path: "/src/value.js",
  folder: "",
  source: "",
  permissions: 0,
  dirty: false,
  busy: false,
  status: "Opening workspace…",
  error: "",
  output: ""
})

export const checkpointAtom = Atom.make(hasSavedCheckpoint).pipe(Atom.withServerValueInitial)

export const editAtom = Atom.fnSync((source: string, ctx) => {
  const state = ctx(playgroundAtom)

  if (state.busy || !(state.permissions & 2)) return
  ctx.set(playgroundAtom, { ...state, source, dirty: true, error: "", output: "", status: "Working copy edited." })
})

const selectFile = Effect.fnUntraced(function*(caller: FileAccess, path: string) {
  const [source, permissions] = path
    ? yield* Effect.all([caller.read(path), caller.permissions(path)])
    : ["", 0] as const

  return { path, source, permissions, dirty: false }
})

const selectReadableFile = Effect.fnUntraced(
  function*(caller: FileAccess, entries: ReadonlyArray<Entry>, preferred: string) {
    const paths = entries.flatMap((entry) => entry.directory ? [] : [entry.path])

    if (paths.includes(preferred) && ((yield* caller.permissions(preferred)) & 4)) {
      return yield* selectFile(caller, preferred)
    }

    for (const candidate of paths) {
      if ((yield* caller.permissions(candidate)) & 4) return yield* selectFile(caller, candidate)
    }

    return yield* selectFile(caller, "")
  }
)

const perform = Effect.fnUntraced(function*(command: Command, state: Playground) {
  if (command === "open" || command === "reopen") {
    const volume = yield* openVolume(command === "reopen" ? (yield* readCheckpoint).image : undefined)
    const caller = volume[state.role]
    const entries = yield* caller.files()

    return {
      volume,
      entries,
      ...yield* selectReadableFile(caller, entries, state.path),
      folder: "",
      output: "",
      status: command === "open" ? "Starter files open in memory." : "Reopened the saved checkpoint."
    }
  }

  const { volume, path, folder, role } = state

  if (!volume) return yield* new PlaygroundError({ message: "Open a workspace first." })
  const caller = volume[role]
  const selected = folder || path
  const flush = state.dirty ? caller.write(path, state.source) : Effect.void

  switch (command) {
    case "save":
      yield* flush
      yield* saveCheckpoint(yield* volume.snapshot())

      return { dirty: false, status: "Saved workspace.sqlite in this browser." }
    case "inspect": {
      const row = yield* readCheckpoint

      return { status: `SQLite row: saved_at = ${row.savedAt}, length(image) = ${row.size} bytes.` }
    }

    case "deleteCheckpoint":
      yield* deleteCheckpoint

      return { status: "Checkpoint deleted. Your working files are still open." }
    case "build": {
      yield* flush

      const result = yield* buildWorkspace(caller)

      return { dirty: false, output: result.code, status: "Built from " + result.reads.join(", ") }
    }

    case "deleteEntry": {
      yield* (folder ? caller.removeFolder(folder) : caller.unlink(path))
      const entries = yield* caller.files()

      const file = !folder || !path || path.startsWith(folder + "/")
        ? yield* selectReadableFile(caller, entries, "") :
        {}

      return {
        entries,
        ...file,
        folder: "",
        output: "",
        status: "Deleted " + selected + (folder ? " and its contents." : "")
      }
    }
  }

  yield* flush

  if ("role" in command) {
    return {
      role: command.role,
      ...yield* selectReadableFile(volume[command.role], state.entries, path),
      output: "",
      status: `Switched to ${command.role}.`
    }
  }

  if ("select" in command) {
    const entry = command.select

    return entry.directory
      ? { folder: entry.path, dirty: false }
      : { folder: "", ...yield* selectFile(caller, entry.path) }
  }

  const { operation, name } = command
  const next = "/" + name

  if (!name.split("/").every((part) => /^[\w-][\w.-]*$/.test(part))) {
    return yield* new PlaygroundError({ message: "Enter a path such as src/message.js." })
  }

  if (operation === "New folder") yield* caller.mkdir(next)
  else if (operation === "New file") yield* caller.create(next)
  else {
    if (selected !== next && state.entries.some((entry) => entry.path === next)) {
      return yield* new PlaygroundError({ message: "That path already exists." })
    }

    yield* caller.rename(selected, next)
  }

  const entries = yield* caller.files()

  const changes = {
    dirty: false,
    entries,
    output: "",
    status: (operation.startsWith("Rename") ? "Renamed to " : "Created ") + next
  }

  if (operation === "New folder") return changes

  if (operation === "Rename folder") {
    const file = path.startsWith(folder + "/") ? yield* selectFile(caller, next + path.slice(folder.length)) : {}

    return { ...changes, folder: next, ...file }
  }

  return { ...changes, folder: "", ...yield* selectFile(caller, next) }
})

export const commandAtom = Atom.fn<Command>()((command, ctx) =>
  Effect.gen(function*() {
    const state = ctx(playgroundAtom)

    if (state.busy || (command === "open" && state.volume)) return false
    ctx.set(playgroundAtom, {
      ...state,
      busy: true,
      error: "",
      output: command === "build" ? "" : state.output,
      status: command === "build" ? "Building /main.js…" : state.status
    })
    const result = yield* Effect.exit(perform(command, state))

    if (Exit.isFailure(result)) {
      const error = Cause.squash(result.cause)
      ctx.set(playgroundAtom, {
        ...ctx(playgroundAtom),
        busy: false,
        error: error instanceof Error ? error.message : String(error),
        status: "Action failed."
      })

      return false
    }

    ctx.set(playgroundAtom, { ...ctx(playgroundAtom), ...result.value, busy: false })

    if (command === "save" || command === "deleteCheckpoint") ctx.refresh(checkpointAtom)

    return true
  }), { concurrent: true })

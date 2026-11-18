import { Cause, Effect, Exit, Result } from "effect"
import { PlaygroundError } from "./error"
import type { Entry as RpcEntry, Role } from "./protocol"
import type { runBundle } from "./run"
import type { FileAccess as LocalAccess } from "./volume"

export type Entry = typeof RpcEntry.Type

type FileAccess = {
  [K in Exclude<keyof LocalAccess, "resolve">]: (...args: Parameters<LocalAccess[K]>) => Effect.Effect<
    K extends "files" ? ReadonlyArray<Entry>
      : K extends "read" | "permissions" ? Effect.Success<ReturnType<LocalAccess[K]>>
      : unknown,
    Error
  >
}

type Workspace = Record<Role, FileAccess>

export type Operation = "New file" | "New folder" | "Rename file" | "Rename folder"

export type Command =
  | "open"
  | "save"
  | "inspect"
  | "reopen"
  | "deleteCheckpoint"
  | "build"
  | "deleteEntry"
  | "refresh"
  | { fileMode: 0o600 | 0o644 }
  | { role: Role }
  | { select: Entry }
  | { operation: Operation; name: string }

interface ViewRefresh {
  path: string
  folder: string
  status: string
  keepEditor?: boolean
}

export interface Playground {
  volume?: Workspace
  role: Role
  entries: ReadonlyArray<Entry>
  path: string
  folder: string
  source: string
  permissions: number
  dirty: boolean
  pendingView?: ViewRefresh | undefined
  busy: boolean
  status: string
  error: string
  output: { code: string; lines: ReadonlyArray<string> | null } | null
}

export const initialPlayground: Playground = {
  role: "editor",
  entries: [],
  path: "/src/value.js",
  folder: "",
  source: "",
  permissions: 0,
  dirty: false,
  busy: false,
  status: "Opening workspace…",
  error: "",
  output: null
}

const selectFile = Effect.fnUntraced(function*(caller: FileAccess, path: string) {
  const [source, permissions] = path
    ? yield* Effect.all([caller.read(path), caller.permissions(path)])
    : ["", 0] as const

  return { path, source, permissions, dirty: false }
})

const selectReadableFile = Effect.fnUntraced(
  function*(caller: FileAccess, entries: ReadonlyArray<Entry>, preferred: string) {
    const files = entries.filter((entry) => !entry.directory && entry.readable)
    const selected = files.find((entry) => entry.path === preferred) ?? files[0]

    return yield* selectFile(caller, selected?.path ?? "")
  }
)

interface Dependencies {
  openVolume: (restore: boolean) => Effect.Effect<Workspace, Error>
  buildWorkspace: (
    caller: FileAccess,
    role: Role
  ) => Effect.Effect<{ code: string; reads: ReadonlyArray<string> }, Error>
  runBundle: typeof runBundle
  inspectCheckpoint: Effect.Effect<{ savedAt: string; size: number }, Error>
  saveCheckpoint: Effect.Effect<void, Error>
  deleteCheckpoint: Effect.Effect<void, Error>
}

const refreshView = Effect.fnUntraced(function*(caller: FileAccess, view: ViewRefresh) {
  const entries = yield* caller.files()

  const changes = {
    entries,
    folder: view.folder,
    status: view.status,
    output: null,
    pendingView: undefined
  }

  return view.keepEditor ? changes : { ...changes, ...yield* selectReadableFile(caller, entries, view.path) }
})

export function makeWorkspaceController({
  openVolume,
  buildWorkspace,
  runBundle,
  inspectCheckpoint,
  saveCheckpoint,
  deleteCheckpoint
}: Dependencies) {
  const perform = Effect.fnUntraced(function*(
    command: Command,
    state: Playground,
    record: (patch: Partial<Playground>) => void
  ) {
    if (command === "open" || command === "reopen") {
      const volume = yield* openVolume(command === "reopen")
      const caller = volume[state.role]
      const entries = yield* caller.files()

      return {
        volume,
        entries,
        ...yield* selectReadableFile(caller, entries, state.path),
        folder: "",
        output: null,
        status: command === "open" ? "Starter files open in memory." : "Reopened the saved checkpoint."
      }
    }

    const { volume, path, folder, role } = state

    if (!volume) return yield* new PlaygroundError({ message: "Open a workspace first." })
    const caller = volume[role]
    const selected = folder || path

    // Record the successful write before exposing an interruption or later command failure.
    const flush = state.dirty
      ? caller.write(path, state.source).pipe(
        Effect.tap(() => Effect.sync(() => record({ dirty: false }))),
        Effect.uninterruptible
      )
      : Effect.void

    const mutate = <E>(change: Effect.Effect<unknown, E>, pendingView: ViewRefresh) =>
      change.pipe(
        Effect.tap(() => Effect.sync(() => record({ pendingView, output: null }))),
        Effect.uninterruptible,
        Effect.andThen(refreshView(caller, pendingView))
      )

    switch (command) {
      case "refresh":
        return state.pendingView ? yield* refreshView(caller, state.pendingView) : {}
      case "save":
        yield* flush
        yield* saveCheckpoint

        return { dirty: false, status: "Saved workspace.sqlite in this browser." }
      case "inspect": {
        const row = yield* inspectCheckpoint

        return { status: `SQLite row: saved_at = ${row.savedAt}, length(image) = ${row.size} bytes.` }
      }

      case "deleteCheckpoint":
        yield* deleteCheckpoint

        return { status: "Checkpoint deleted. Your working files are still open." }
      case "build": {
        yield* flush

        const result = yield* buildWorkspace(caller, role)

        const run = yield* Effect.result(runBundle(result.code))

        if (Result.isFailure(run)) {
          return {
            dirty: false,
            output: { code: result.code, lines: null },
            error: run.failure.message,
            status: "Built successfully. Execution failed."
          }
        }

        return {
          dirty: false,
          output: { code: result.code, lines: run.success.lines },
          error: run.success.error ?? "",
          status: run.success.error !== undefined
            ? "Built successfully. Execution failed."
            : "Built and ran from " + result.reads.join(", ")
        }
      }

      case "deleteEntry": {
        const keepEditor = Boolean(folder && path && !path.startsWith(folder + "/"))

        const remove = folder
          ? caller.removeFolder(folder).pipe(Effect.tapError(() =>
            Effect.sync(() =>
              record({
                pendingView: { path, folder: "", keepEditor, status: "Refreshed the workspace after deletion failed." },
                output: null
              })
            )
          ))
          : caller.unlink(path)

        return yield* mutate(remove, {
          path: "",
          folder: "",
          keepEditor,
          status: "Deleted " + selected + (folder ? " and its contents." : "")
        })
      }
    }

    yield* flush

    if ("fileMode" in command) {
      const file = state.entries.find((entry) => entry.path === selected)

      if (role !== "admin" || !file?.policy) {
        return yield* new PlaygroundError({ message: "Select a regular file as Admin to change its access." })
      }

      return yield* mutate(caller.setFileMode(selected, command.fileMode), {
        path,
        folder,
        status: command.fileMode === 0o644 ? `Everyone can read ${selected}.` : `${selected} is private.`
      })
    }

    if ("role" in command) {
      const nextCaller = volume[command.role]
      const entries = yield* nextCaller.files()

      return {
        entries,
        role: command.role,
        ...yield* selectReadableFile(nextCaller, entries, path),
        output: null,
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

    if (operation === "New folder") {
      return yield* mutate(caller.mkdir(next), { path, folder, status: "Created " + next })
    }

    if (operation === "New file") {
      return yield* mutate(caller.create(next), { path: next, folder: "", status: "Created " + next })
    }

    if (selected !== next && state.entries.some((entry) => entry.path === next)) {
      return yield* new PlaygroundError({ message: "That path already exists." })
    }

    const status = "Renamed to " + next

    if (operation === "Rename folder") {
      const preferred = path.startsWith(folder + "/") ? next + path.slice(folder.length) : path

      return yield* mutate(caller.rename(selected, next), { path: preferred, folder: next, status })
    }

    return yield* mutate(caller.rename(selected, next), { path: next, folder: "", status })
  })

  const execute = (
    command: Command,
    read: () => Playground,
    publish: (state: Playground) => void
  ): Effect.Effect<boolean> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function*() {
        const state = read()

        if (state.busy || (command === "open" && state.volume) || (state.pendingView && command !== "refresh")) {
          return false
        }

        let current = { ...state, error: "", output: command === "build" ? null : state.output }
        publish({
          ...current,
          busy: true,
          status: command === "build" ? "Building /main.js…" : state.status
        })

        const result = yield* Effect.exit(restore(perform(command, state, (patch) => {
          current = { ...current, ...patch }
        })))

        if (Exit.isSuccess(result)) {
          publish({ ...current, ...result.value, busy: false })

          return true
        }

        const error = Cause.squash(result.cause)
        publish({
          ...current,
          busy: false,
          error: error instanceof Error ? error.message : String(error),
          status: current.pendingView ? "Refresh the workspace to continue." : "Action failed."
        })

        return false
      })
    )

  return { edit: editPlayground, execute }
}

export const editPlayground = (state: Playground, source: string): Playground =>
  state.busy || state.pendingView || !(state.permissions & 2)
    ? state
    : { ...state, source, dirty: true, error: "", output: null, status: "Working copy edited." }

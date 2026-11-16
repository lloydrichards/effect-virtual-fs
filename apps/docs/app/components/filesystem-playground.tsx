/* oxlint-disable effecttsgo/async-function -- React event handlers sequence editor commands and update component state. */
import {
  Braces,
  ChevronRight,
  Database,
  FileCode2,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Play,
  RotateCcw,
  Save,
  Terminal,
  Trash2
} from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { FileAccess, Workspace } from "~/lib/playground/volume"
import { PlaygroundEditor } from "./playground-editor"
import { Button } from "./ui/button"

type Entry = Awaited<ReturnType<FileAccess["files"]>>[number]

type Role = keyof Pick<Workspace, "editor" | "reader">

function FileList({ entries, parent, selected, onSelect }: {
  entries: ReadonlyArray<Entry>
  parent: string
  selected: string
  onSelect: (entry: Entry) => void
}) {
  const [collapsed, setCollapsed] = useState<ReadonlyArray<string>>([])

  return (
    <ul className="space-y-0.5">
      {entries.filter(({ path }) => path.slice(0, path.lastIndexOf("/")) === parent).map((entry) => {
        const name = entry.path.slice(parent.length + 1)

        const expanded = !collapsed.includes(entry.path)
        const Icon = entry.directory ? Folder : FileCode2

        return (
          <li key={entry.path}>
            <div className="flex items-center">
              {entry.directory && (
                <button
                  type="button"
                  aria-label={`${expanded ? "Collapse" : "Expand"} ${entry.path}`}
                  aria-expanded={expanded}
                  onClick={() =>
                    setCollapsed(expanded ? [...collapsed, entry.path] : collapsed.filter((p) => p !== entry.path))}
                  className="rounded p-1 hover:bg-sidebar-accent"
                >
                  <ChevronRight className={expanded ? "size-3 rotate-90" : "size-3"} />
                </button>
              )}
              <button
                type="button"
                aria-label={entry.path}
                aria-current={entry.path === selected ? "true" : undefined}
                onClick={() => onSelect(entry)}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-2 py-1.5 text-left font-mono text-xs hover:bg-sidebar-accent aria-current:bg-accent aria-current:font-semibold aria-current:text-primary"
              >
                <Icon className="size-3.5 shrink-0" />
                <span className="break-all">{name}</span>
              </button>
            </div>
            {entry.directory && expanded && (
              <div className="ms-3 border-s ps-1">
                <FileList entries={entries} parent={entry.path} selected={selected} onSelect={onSelect} />
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export function FilesystemPlayground() {
  const [workspace, setWorkspace] = useState<Workspace>()
  const [role, setRole] = useState<Role>("editor")
  const [permissions, setPermissions] = useState(0)
  const [entries, setEntries] = useState<ReadonlyArray<Entry>>([])
  const [path, setPath] = useState("/src/value.js")
  const [source, setSource] = useState("")
  const [dirty, setDirty] = useState(false)
  const [folder, setFolder] = useState("")
  const selected = folder || path
  const renameAction = folder ? "Rename folder" : "Rename file"
  const [operation, setOperation] = useState<"New file" | "New folder" | "Rename file" | "Rename folder" | null>(null)
  const [name, setName] = useState("")
  const [hasCheckpoint, setHasCheckpoint] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState("Opening workspace…")
  const [output, setOutput] = useState("")
  const [error, setError] = useState("")
  const locked = useRef(false)

  useEffect(() => {
    let active = true

    function refreshCheckpoint() {
      void import("~/lib/playground/storage").then(({ hasSavedCheckpoint }) => hasSavedCheckpoint())
        .catch(() => false)
        .then((exists) => {
          if (active) setHasCheckpoint(exists)
        })
    }

    refreshCheckpoint()
    window.addEventListener("focus", refreshCheckpoint)

    async function start() {
      const { openVolume } = await import("~/lib/playground/volume")
      const volume = await openVolume()

      const [tree, text, bits] = await Promise.all([
        volume.editor.files(),
        volume.editor.read("/src/value.js"),
        volume.editor.permissions("/src/value.js")
      ])

      if (active) {
        setWorkspace(volume)
        setEntries(tree)
        setSource(text)
        setPermissions(bits)
        setStatus("Starter files open in memory.")
      }
    }

    void start().catch((cause) => {
      if (active) {
        setError(String(cause))
        setStatus("Could not open workspace.")
      }
    })

    return () => {
      active = false
      window.removeEventListener("focus", refreshCheckpoint)
    }
  }, [])

  async function act(task: (volume: Workspace, caller: FileAccess) => Promise<void>) {
    if (!workspace || locked.current) return
    locked.current = true
    setBusy(true)
    setError("")

    try {
      await task(workspace, workspace[role])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setStatus("Action failed.")
    } finally {
      locked.current = false
      setBusy(false)
    }
  }

  async function flush(caller: FileAccess) {
    if (dirty) {
      await caller.write(path, source)
      setDirty(false)
    }
  }

  async function select(caller: FileAccess, next: string) {
    const [text, bits] = next ? await Promise.all([caller.read(next), caller.permissions(next)]) : ["", 0] as const
    setPath(next)
    setSource(text)
    setPermissions(bits)
    setDirty(false)
  }

  const edit = useCallback((text: string) => {
    setSource(text)
    setDirty(true)
    setError("")
    setOutput("")
    setStatus("Working copy edited.")
  }, [])

  const writable = (permissions & 2) !== 0

  return (
    <fieldset
      disabled={!workspace || busy}
      className="my-5 min-w-0 overflow-hidden rounded-xl border border-code-block-border bg-card text-card-foreground shadow-sm"
    >
      <legend className="sr-only">Virtual filesystem editor</legend>
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2">
        <span className="me-auto inline-flex items-center gap-2 text-sm font-semibold">
          <Terminal className="size-4 text-primary" />Workspace
        </span>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Caller
          <select
            className="rounded-md border bg-background px-2 py-1 text-foreground"
            value={role}
            onChange={(event) => {
              const next = event.target.value === "reader" ? "reader" : "editor"
              void act(async (volume, caller) => {
                await flush(caller)
                await select(volume[next], path)
                setRole(next)
                setOperation(null)
                setStatus(`Switched to ${next}.`)
              })
            }}
          >
            <option value="editor">Editor</option>
            <option value="reader">Reader</option>
          </select>
        </label>
        <Button
          onClick={() =>
            act(async (_, caller) => {
              setOutput("")
              setStatus("Building /main.js…")
              await flush(caller)
              const { buildWorkspace } = await import("~/lib/playground/build")
              const result = await buildWorkspace(caller)
              setOutput(result.code)
              setStatus("Built from " + result.reads.join(", "))
            })}
        >
          <Play />Run build
        </Button>
      </div>
      <div className="grid min-w-0 sm:grid-cols-[minmax(8rem,28%)_minmax(0,1fr)]">
        <aside aria-label="Project files" className="min-w-0 border-b bg-sidebar p-2 sm:border-e sm:border-b-0">
          <div className="mb-1 flex items-center gap-1.5 px-1 text-xs font-semibold">
            <FolderOpen className="size-4" />Files
          </div>
          <div className="mb-2 flex flex-wrap gap-1 border-b pb-1">
            {([
              ["New file", FilePlus2],
              ["New folder", FolderPlus],
              [renameAction, Pencil]
            ] as const).map(([action, Icon]) => (
              <Button
                key={action}
                size="icon-xs"
                variant="ghost"
                aria-label={action}
                title={action}
                disabled={role !== "editor" || (action === renameAction && !selected)}
                onClick={() => {
                  setOperation(operation === action ? null : action)
                  setName(
                    action === renameAction
                      ? selected.slice(1)
                      : folder
                      ? folder.slice(1) + "/"
                      : path.slice(1, path.lastIndexOf("/") + 1)
                  )
                }}
              >
                <Icon />
              </Button>
            ))}
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={folder ? "Delete folder" : "Delete file"}
              title={folder ? `Delete ${folder} and its contents` : `Delete ${path}`}
              disabled={role !== "editor" || !selected}
              onClick={() =>
                act(async (_, caller) => {
                  if (folder) await caller.removeFolder(folder)
                  else await caller.unlink(path)
                  const tree = await caller.files()

                  if (!folder || !path || path.startsWith(folder + "/")) {
                    await select(caller, tree.find((entry) => !entry.directory)?.path ?? "")
                  }

                  setFolder("")
                  setEntries(tree)
                  setOperation(null)
                  setOutput("")
                  setStatus("Deleted " + selected + (folder ? " and its contents." : ""))
                })}
            >
              <Trash2 />
            </Button>
          </div>
          {operation && (
            <form
              className="mb-2 space-y-1"
              onSubmit={(event) => {
                event.preventDefault()
                void act(async (_, caller) => {
                  const next = "/" + name

                  if (!name.split("/").every((part) => /^[\w-][\w.-]*$/.test(part))) {
                    throw new Error("Enter a path such as src/message.js.")
                  }

                  await flush(caller)

                  if (operation === renameAction) {
                    if (entries.some((entry) => entry.path === next && next !== selected)) {
                      throw new Error("That path already exists.")
                    }

                    await caller.rename(selected, next)
                  } else if (operation === "New folder") {
                    await caller.mkdir(next)
                  } else {
                    await caller.create(next)
                  }

                  setEntries(await caller.files())

                  if (operation === "Rename folder") {
                    setFolder(next)

                    if (path.startsWith(folder + "/")) await select(caller, next + path.slice(folder.length))
                  } else if (operation !== "New folder") {
                    await select(caller, next)
                    setFolder("")
                  }

                  setOperation(null)
                  setStatus((operation === renameAction ? "Renamed to " : "Created ") + next)
                  setOutput("")
                })
              }}
            >
              <input
                aria-label={operation + " path"}
                placeholder={operation === "New folder" ? "src/lib" : "src/message.js"}
                value={name}
                maxLength={150}
                onChange={(event) => setName(event.target.value)}
                className="w-full rounded border bg-background p-1 font-mono text-xs"
              />
              <Button type="submit" size="xs" variant="outline">
                {operation === "New folder" ? "Add folder" : operation === renameAction ? "Rename" : "Add file"}
              </Button>
            </form>
          )}
          <FileList
            entries={entries}
            parent=""
            selected={selected}
            onSelect={(entry) =>
              act(async (_, caller) => {
                await flush(caller)

                if (!entry.directory) await select(caller, entry.path)
                setFolder(entry.directory ? entry.path : "")
                setOperation(null)
              })}
          />
        </aside>
        <div className="min-w-0 bg-code-block">
          <div className="flex flex-wrap items-center gap-2 border-b bg-card px-3 py-2 font-mono text-xs">
            <Braces className="size-3.5 text-primary" />
            <span className="break-all">{path || "No file open"}{dirty && <span aria-label="Modified">*</span>}</span>
            <span className="ms-auto text-muted-foreground">{path && (writable ? "Read / write" : "Read only")}</span>
          </div>
          <PlaygroundEditor
            path={path}
            label={`Edit ${path}`}
            value={source}
            readOnly={!writable || busy}
            onEdit={edit}
          />
        </div>
      </div>
      <div className="border-t bg-muted/30 px-3 py-2">
        <p role="status" className="break-words font-mono text-xs text-muted-foreground">{status}</p>
        {error && (
          <pre role="alert" className="mt-2 whitespace-pre-wrap break-words text-xs text-destructive">{error}</pre>
        )}
        {output && (
          <div className="mt-2">
            <h3 className="text-xs font-semibold">Generated bundle</h3>
            <PlaygroundEditor path="bundle.js" label="Generated bundle" value={output} readOnly />
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1 border-t p-2">
        <Button
          variant="outline"
          onClick={() =>
            act(async (volume, caller) => {
              await flush(caller)
              const { saveCheckpoint } = await import("~/lib/playground/storage")
              await saveCheckpoint(await volume.snapshot())
              setHasCheckpoint(true)
              setStatus("Saved workspace.sqlite in this browser.")
            })}
        >
          <Save />Save checkpoint
        </Button>
        <Button
          variant="ghost"
          disabled={!hasCheckpoint}
          onClick={() =>
            act(async () => {
              const { readCheckpoint } = await import("~/lib/playground/storage")
              const row = await readCheckpoint()
              setStatus(`SQLite row: saved_at = ${row.savedAt}, length(image) = ${row.size} bytes.`)
            })}
        >
          <Database />Inspect saved row
        </Button>
        <Button
          variant="ghost"
          disabled={!hasCheckpoint}
          onClick={() =>
            act(async () => {
              const { readCheckpoint } = await import("~/lib/playground/storage")
              const { openVolume } = await import("~/lib/playground/volume")
              const saved = await openVolume((await readCheckpoint()).image)
              const tree = await saved[role].files()
              const fallback = tree.find((entry) => !entry.directory)?.path

              await select(
                saved[role],
                tree.some((entry) => entry.path === path && !entry.directory)
                  ? path
                  : fallback ?? ""
              )
              setFolder("")
              setWorkspace(saved)
              setEntries(tree)
              setOperation(null)
              setOutput("")
              setStatus("Reopened the saved checkpoint.")
            })}
        >
          <RotateCcw />Reopen saved
        </Button>
        <Button
          variant="ghost"
          disabled={!hasCheckpoint}
          onClick={() =>
            act(async () => {
              const { deleteCheckpoint } = await import("~/lib/playground/storage")
              await deleteCheckpoint()
              setHasCheckpoint(false)
              setStatus("Checkpoint deleted. Your working files are still open.")
            })}
        >
          <Trash2 />Delete checkpoint
        </Button>
      </div>
    </fieldset>
  )
}
